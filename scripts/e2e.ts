/**
 * End-to-end test against a local mock of the Wise API, in a single process:
 * boots the server, runs the OAuth flow like Claude does (login = pasted Wise token),
 * then checks the allowlist, session lengths, encryption at rest, /sessions, every tool,
 * amount parsing, pagination, and token revocation in Wise.
 *   npm run e2e
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DATA = "./data-e2e";
const PORT = 3988;
const MOCK_PORT = 3987;
const B = `http://localhost:${PORT}`;
const M = `http://localhost:${MOCK_PORT}`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OWNER = 101; // allowed Wise user
const STRANGER = 202;
const PERSONAL = 1001;
const BUSINESS = 1002;
const storedConnections = () => {
  try {
    return Object.keys(JSON.parse(readFileSync(path.join(DATA, "wise", "connections.json"), "utf8"))).length;
  } catch {
    return 0;
  }
};
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

/** Verify actual ACLs on Windows; Node's numeric mode reports 0666 there. */
async function hasPrivatePermissions(file: string) {
  if (process.platform !== "win32") return (statSync(file).mode & 0o777) === (file === DATA ? 0o700 : 0o600);
  try {
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).match(/S-1-5-(?:\d+-)+\d+/)?.[0];
    if (!sid) return false;
    const command = "(Get-Acl -LiteralPath $env:WISE_MCP_TEST_FILE).Access | " +
      "Where-Object { $_.AccessControlType -eq 'Allow' } | " +
      "ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, WISE_MCP_TEST_FILE: path.resolve(file) },
    });
    const output = stdout.trim();
    const parsed: unknown = JSON.parse(output);
    const grants = Array.isArray(parsed) ? parsed : [parsed];
    const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544"]); // user, SYSTEM, Administrators
    return grants.length > 0 && grants.every((entry) => typeof entry === "string" && allowed.has(entry));
  } catch {
    return false;
  }
}

// --- Mock Wise -------------------------------------------------------------------
const tokens: Record<string, number> = {}; // Wise API token -> Wise user id
const revoked = new Set<string>();
const newToken = (user: number) => {
  const t = randomUUID();
  tokens[t] = user;
  return t;
};
const queries: URL[] = [];
const readOnlyTokens = new Set<string>();
const quotes: Record<string, any> = {};
const quoteBodies: any[] = [];
const created: any[] = []; // transfers created through the API
const createCalls: string[] = []; // customerTransactionIds seen
const newRecipients: any[] = [];
const headersSeen: Record<string, string | undefined> = {};
const RATES: Record<string, number> = { EUREUR: 1, EURRON: 4.97, EURGBP: 0.85 };

// 150 activities on the personal profile, newest first, 1 hour apart.
const T0 = Date.parse("2026-10-10T12:00:00Z");
const special = [
  { type: "CARD_PAYMENT", title: "<strong>Coop</strong>", description: "Spent", primaryAmount: "24.73 EUR", secondaryAmount: "Roundup", resource: { type: "CARD_TRANSACTION", id: "9001" } },
  { type: "TRANSFER", title: "<strong>Acme Payroll</strong>", description: "Received", primaryAmount: "<positive>+ 4,500 EUR</positive>", secondaryAmount: "", resource: { type: "TRANSFER", id: "7001" } },
  { type: "INTERBALANCE", title: "Moved to <strong>No More Debts</strong>", description: "", primaryAmount: "2,000 EUR", secondaryAmount: "", resource: { type: "BALANCE_TRANSACTION", id: "8001" } },
  { type: "CARD_PAYMENT", title: "<strong>Lidl &amp; Co</strong>", description: "Pending", primaryAmount: "100 RON", secondaryAmount: "20.12 EUR", resource: { type: "CARD_TRANSACTION", id: "9002" } },
];
const activities = Array.from({ length: 150 }, (_, i) => ({
  id: `act-${i}`,
  status: "COMPLETED",
  createdOn: new Date(T0 - i * 3600_000).toISOString(),
  updatedOn: new Date(T0 - i * 3600_000).toISOString(),
  ...(special[i] ?? { type: "CARD_PAYMENT", title: `<strong>Shop ${i}</strong>`, description: "Spent", primaryAmount: `${i}.50 EUR`, secondaryAmount: "", resource: { type: "CARD_TRANSACTION", id: String(10000 + i) } }),
}));
// Oldest first, like Wise without date filters.
const transfers = [
  { id: 7000, created: "2026-01-05 10:00:00", status: "outgoing_payment_sent", reference: "rent jan", sourceValue: 500, sourceCurrency: "EUR", targetValue: 2480, targetCurrency: "RON", targetAccount: 501, rate: 4.96 },
  { id: 7001, created: "2026-09-01 10:00:00", status: "outgoing_payment_sent", reference: "dinner", sourceValue: 40, sourceCurrency: "EUR", targetValue: 40, targetCurrency: "EUR", targetAccount: 501, rate: 1 },
  { id: 7002, created: "2026-10-01 10:00:00", status: "processing", reference: "", details: { reference: "invoice 42" }, sourceValue: 100, sourceCurrency: "EUR", targetValue: 85, targetCurrency: "GBP", targetAccount: 502, rate: 0.85 },
];
const recipients: Record<number, any> = {
  501: { id: 501, profileId: PERSONAL, name: { fullName: "Mario Rossi" }, currency: "EUR", type: "iban", accountSummary: "IT60 X054 2811 1010 0000 0123 456", ownedByCustomer: false, active: true },
  502: { id: 502, profileId: BUSINESS, name: "ACME Ltd", currency: "GBP", type: "sort_code", accountSummary: "40-30-20 41234567", longAccountSummary: "GBP account ending 4567", active: true },
};

const mock = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  const url = new URL(req.url!, M);
  queries.push(url);
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const user = tokens[token];
  if (user === undefined || revoked.has(token)) return send(401, { error: "invalid_token", error_description: "Invalid token" });
  const p = url.pathname;
  const q = url.searchParams;

  if (p === "/v1/me") return send(200, { id: user, name: user === OWNER ? "Jane Doe" : "Stranger", email: "a@example.com", active: true });
  if (user !== OWNER) return send(403, { error: "forbidden" });
  if (readOnlyTokens.has(token) && req.method !== "GET") return send(403, { errors: [{ code: "forbidden", message: "Token has read-only access" }] });
  let w = p.match(/^\/v3\/profiles\/(\d+)\/quotes$/);
  if (w && req.method === "POST") {
    const rate = RATES[body.sourceCurrency + body.targetCurrency] ?? 1;
    quoteBodies.push(body);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // Like Wise: each pay-in has its own fee; preferredPayIn moves that option first, and the transfer uses the first one.
    const opt = (payIn: string, fee: number) =>
      body.sourceAmount != null
        ? { payIn, payOut: "BANK_TRANSFER", disabled: false, fee: { total: fee }, sourceAmount: body.sourceAmount, targetAmount: r2((body.sourceAmount - fee) * rate) }
        : { payIn, payOut: "BANK_TRANSFER", disabled: false, fee: { total: fee }, sourceAmount: r2(body.targetAmount / rate + fee), targetAmount: body.targetAmount };
    const paymentOptions: any[] = [
      opt("BANK_TRANSFER", 0.8),
      { ...opt("BALANCE", 0.5), formattedEstimatedDelivery: "by <strong>Monday</strong>" },
      { payIn: "BALANCE", payOut: "SWIFT", disabled: false, fee: { total: 9 } },
    ];
    if (body.preferredPayIn) paymentOptions.sort((a, b) => Number(b.payIn === body.preferredPayIn) - Number(a.payIn === body.preferredPayIn));
    const src = paymentOptions[0].sourceAmount;
    const tgt = paymentOptions[0].targetAmount;
    const q = {
      id: randomUUID(), profile: Number(w[1]), sourceCurrency: body.sourceCurrency, targetCurrency: body.targetCurrency, sourceAmount: src, targetAmount: tgt,
      rate, rateType: "FIXED", rateExpirationTime: "2026-10-12T12:00:00Z", payOut: "BANK_TRANSFER", targetAccount: body.targetAccount,
      paymentOptions,
    };
    quotes[q.id] = q;
    return send(200, q);
  }
  w = p.match(/^\/v1\/quotes\/([\w-]+)\/account-requirements$/);
  if (w) {
    headersSeen.minor = req.headers["accept-minor-version"] as string;
    if (!quotes[w[1]]) return send(404, { errors: [{ message: "quote not found" }] });
    return send(200, [{ type: "iban", title: "IBAN", fields: [
      { name: "Legal type", group: [{ key: "legalType", name: "Legal type", type: "radio", required: true, valuesAllowed: [{ key: "PRIVATE", name: "Person" }, { key: "BUSINESS", name: "Business" }] }] },
      { name: "IBAN", group: [{ key: "IBAN", name: "IBAN", type: "text", required: true, example: "DE89370400440532013000", validationRegexp: "^[A-Z]{2}[0-9]{2}[A-Z0-9]+$" }] },
    ] }]);
  }
  if (p === "/v1/accounts" && req.method === "POST") {
    if (!body.details?.IBAN) return send(422, { errors: [{ code: "NOT_VALID", path: "IBAN", message: "Please specify IBAN" }] });
    const r = { id: 503 + newRecipients.length, profile: body.profile, accountHolderName: body.accountHolderName, currency: body.currency, type: body.type, details: body.details, accountSummary: body.details.IBAN, active: true };
    newRecipients.push(r);
    recipients[r.id] = { ...r, profileId: body.profile, name: { fullName: body.accountHolderName } };
    return send(200, r);
  }
  if (p === "/v1/transfer-requirements" && req.method === "POST") {
    const fields: any[] = [{ name: "Reference", group: [{ key: "reference", name: "Reference", required: false }] }];
    if (quotes[body.quoteUuid]?.targetCurrency === "GBP") {
      fields.push({ name: "Purpose", group: [{ key: "transferPurpose", name: "Transfer purpose", required: true, valuesAllowed: [{ key: "verification.transfers.purpose.pay.bills", name: "Paying bills" }] }] });
    }
    return send(200, [{ type: "transfer", fields }]);
  }
  if (p === "/v1/transfers" && req.method === "POST") {
    createCalls.push(body.customerTransactionId);
    const existing = created.find((t) => t.customerTransactionId === body.customerTransactionId);
    if (existing) return send(200, existing);
    const q = quotes[body.quoteUuid];
    if (!q || q.used) return send(422, { errors: [{ code: "quote.invalid", message: "Quote is invalid or already used" }] });
    q.used = true;
    const t = { id: 8000 + created.length, user, targetAccount: body.targetAccount, quoteUuid: q.id, customerTransactionId: body.customerTransactionId, status: "incoming_payment_waiting", reference: body.details?.reference ?? "", details: body.details, rate: q.rate, created: "2026-10-11 18:00:00", sourceCurrency: q.sourceCurrency, sourceValue: 0, targetCurrency: q.targetCurrency, targetValue: 0 };
    // Like Wise: an API-created transfer is priced as a BANK_TRANSFER pay-in until paid, whatever the quote lists
    // first; sourceValue excludes the fee.
    const o = q.paymentOptions.find((x: any) => !x.disabled && x.payIn === "BANK_TRANSFER" && x.payOut === q.payOut);
    Object.assign(t, { sourceValue: Math.round((o.sourceAmount - o.fee.total) * 100) / 100, targetValue: o.targetAmount });
    // Simulates Wise pricing a transfer differently from what the user approved.
    if (q.sourceAmount === 1.23) Object.assign(t, { sourceValue: 0.05, targetValue: 0.05 });
    created.push(t);
    transfers.push(t as any);
    return send(200, t);
  }
  w = p.match(/^\/v1\/transfers\/(\d+)\/cancel$/);
  if (w && req.method === "PUT") {
    const t = created.find((x) => x.id === Number(w![1]));
    if (!t || t.status !== "incoming_payment_waiting") return send(409, { errors: [{ code: "transfer.cancellation.not.allowed", message: "Cannot cancel" }] });
    t.status = "cancelled";
    return send(200, t);
  }
  if (p === "/v2/profiles") {
    return send(200, [
      { id: PERSONAL, type: "PERSONAL", fullName: "Jane Doe" },
      { id: BUSINESS, type: "BUSINESS", fullName: "BlanketByte SRL" },
    ]);
  }
  let m = p.match(/^\/v4\/profiles\/(\d+)\/balances$/);
  if (m) {
    const types = q.get("types");
    if (Number(m[1]) === PERSONAL) {
      return send(200, types === "SAVINGS"
        ? [{ id: 3, type: "SAVINGS", name: "No More Debts", currency: "EUR", amount: { value: 15.71, currency: "EUR" }, reservedAmount: { value: 0 }, totalWorth: { value: 15.71 } }]
        : [
            { id: 1, type: "STANDARD", name: null, currency: "EUR", amount: { value: 559.38, currency: "EUR" }, reservedAmount: { value: 153.7 }, totalWorth: { value: 559.38 } },
            { id: 2, type: "STANDARD", name: null, currency: "USD", amount: { value: 0, currency: "USD" }, reservedAmount: { value: 0 }, totalWorth: { value: 0 } },
          ]);
    }
    return send(200, types === "SAVINGS" ? [] : [
      { id: 4, type: "STANDARD", currency: "EUR", amount: { value: 94.69, currency: "EUR" }, reservedAmount: { value: 0 }, totalWorth: { value: 94.69 } },
      { id: 5, type: "STANDARD", currency: "GBP", amount: { value: 0, currency: "GBP" }, reservedAmount: { value: 0 }, totalWorth: { value: 0 } },
    ]);
  }
  m = p.match(/^\/v1\/profiles\/(\d+)\/activities$/);
  if (m) {
    const size = Number(q.get("size") ?? 10);
    if (size < 1 || size > 100) return send(400, { errors: [{ message: "size must be 1..100" }] });
    let list = Number(m[1]) === PERSONAL ? activities : [{ ...activities[5], id: "biz-1", title: "<strong>AWS</strong>" }];
    const type = q.get("monetaryResourceType");
    if (type) list = list.filter((a) => a.resource.type === type);
    if (q.get("since")) list = list.filter((a) => a.createdOn >= q.get("since")!);
    if (q.get("until")) list = list.filter((a) => a.createdOn <= q.get("until")!);
    const start = Number(q.get("nextCursor") ?? 0);
    const page = list.slice(start, start + size);
    return send(200, { cursor: start + size < list.length ? String(start + size) : null, activities: page });
  }
  if (p === "/v1/transfers") {
    const list = Number(q.get("profile")) === PERSONAL ? transfers : [];
    const offset = Number(q.get("offset") ?? 0);
    return send(200, list.slice(offset, offset + Number(q.get("limit") ?? 20)));
  }
  m = p.match(/^\/v1\/transfers\/(\d+)$/);
  if (m) {
    if (m[1] === "999") return send(403, { errors: [{ message: "Forbidden for this token" }] }); // not a revocation
    const t = transfers.find((x) => x.id === Number(m![1]));
    return t ? send(200, t) : send(404, { errors: [{ message: "Transfer not found" }] });
  }
  if (p === "/v2/accounts") {
    const list = Object.values(recipients).filter((r) => r.profileId === Number(q.get("profileId")) && r.id <= 502);
    return send(200, { content: list, size: list.length });
  }
  m = p.match(/^\/v2\/accounts\/(\d+)$/);
  if (m) return recipients[Number(m[1])] ? send(200, recipients[Number(m[1])]) : send(404, {});
  if (p === "/v1/rates") return send(200, [{ rate: 4.9712, source: q.get("source"), target: q.get("target"), time: q.get("time") ?? "2026-10-11T10:00:00+0000" }]);
  send(404, { errors: [{ message: "not mocked: " + p }] });
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, r));

// --- Boot the server ----------------------------------------------------------------
rmSync(DATA, { recursive: true, force: true });
Object.assign(process.env, {
  PUBLIC_URL: B,
  PORT: String(PORT),
  ALLOWED_WISE_USERS: String(OWNER),
  TOKEN_ENCRYPTION_KEY: "e2e-encryption-key-that-is-long-enough",
  DATA_DIR: DATA,
  WISE_API_URL: M,
  MAX_TRANSFER_AMOUNT: "1000",
});
await import("../src/index.js");
const { parseAmount } = await import("../src/wise/service.js");
for (let i = 0; i < 50 && !(await fetch(`${B}/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));

// --- Parsing ------------------------------------------------------------------------
const pa = (s: string, t?: string) => JSON.stringify(parseAmount(s, t));
check("parse plain amount (out)", pa("24.73 EUR") === JSON.stringify({ amount: 24.73, currency: "EUR", direction: "out" }));
check("parse incoming with thousands", pa("<positive>+ 4,500 EUR</positive>") === JSON.stringify({ amount: 4500, currency: "EUR", direction: "in" }));
check("parse 2,000 / 1.234,56 / interbalance neutral", parseAmount("2,000 EUR")!.amount === 2000 && parseAmount("1.234,56 EUR")!.amount === 1234.56 && parseAmount("5 EUR", "INTERBALANCE")!.direction === "neutral");
check("non-amount text ignored", parseAmount("Roundup") === undefined);

// --- Basics -------------------------------------------------------------------------
check("health", (await fetch(`${B}/health`)).ok);
check("unauthenticated MCP request rejected", (await fetch(`${B}/mcp`, { method: "POST" })).status === 401);
const ico = await fetch(`${B}/favicon.ico`);
const icoBytes = Buffer.from(await ico.arrayBuffer());
check("favicon.ico is a multi-size ICO", ico.headers.get("content-type") === "image/x-icon" && icoBytes.readUInt16LE(2) === 1 && icoBytes.readUInt16LE(4) >= 3);
check("icon.png / favicon.png served", (await fetch(`${B}/icon.png`)).headers.get("content-type") === "image/png" && (await fetch(`${B}/favicon.png`)).ok);
const types = await Promise.all(["/logo.svg", "/logo.png", "/apple-touch-icon.png"].map((p) => fetch(B + p).then((r) => r.headers.get("content-type"))));
check("logo assets served", JSON.stringify(types) === JSON.stringify(["image/svg+xml", "image/png", "image/png"]), types.join(","));
const home = await fetch(`${B}/`).then((r) => r.text());
check("pages show the version", home.includes(`>v${JSON.parse(readFileSync("package.json", "utf8")).version}</a></footer>`));
check("no HTTP warning on localhost", !home.includes('class="insecure"'));
const viaHttp = await fetch(`${B}/`, { headers: { "x-forwarded-host": "wise.example.com", "x-forwarded-proto": "http" } }).then((r) => r.text());
const viaHttps = await fetch(`${B}/`, { headers: { "x-forwarded-host": "wise.example.com", "x-forwarded-proto": "https" } }).then((r) => r.text());
check("red warning when a real domain is served over HTTP", viaHttp.includes('class="insecure"') && viaHttp.includes("Don't paste your Wise token"));
check("no warning over HTTPS", !viaHttps.includes('class="insecure"'));
check("pages link the icon", /rel="icon" href="\/favicon\.ico\?v=[0-9a-f]{10}"/.test(home));
const as: any = await fetch(`${B}/.well-known/oauth-authorization-server`).then((r) => r.json());
const prm: any = await fetch(`${B}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
check("OAuth metadata", as.issuer.startsWith(B) && as.code_challenge_methods_supported?.includes("S256") && prm.resource === `${B}/mcp`);
const evil = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
check("foreign redirect host refused", evil.status === 400);
const gpt = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" }) });
check("ChatGPT can register", gpt.status === 201);
const client: any = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) }).then((r) => r.json());

/** Runs the Claude-side OAuth flow up to the login page; returns login id, page and PKCE verifier. */
async function openLogin() {
  const verifier = randomBytes(32).toString("base64url");
  const au = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1", resource: `${B}/mcp` })) au.searchParams.set(k, v);
  const res = await fetch(au);
  const html = await res.text();
  return { res, html, verifier, loginId: html.match(/name="login_id" value="([^"]+)"/)![1] };
}
const submit = (loginId: string, token: string, ttl: string) =>
  fetch(`${B}/login`, { method: "POST", body: new URLSearchParams({ login_id: loginId, token, ttl }), redirect: "manual" });
async function finishLogin(verifier: string, res: Response) {
  const loc = new URL(res.headers.get("location")!);
  return fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${B}/mcp` }) }).then((r) => r.json() as Promise<any>);
}
async function login(token: string, ttl: string) {
  const l = await openLogin();
  return finishLogin(l.verifier, await submit(l.loginId, token, ttl));
}

// --- Login page -----------------------------------------------------------------------
const first = await openLogin();
check("login page asks for token + session lengths", first.html.includes('name="token" type="password"') && ["5 days", "15 days", "30 days", "90 days", "Always"].every((l) => first.html.includes(l)));
check("30 days is the default", first.html.includes('value="30" checked'));
const csp = first.res.headers.get("content-security-policy") ?? "";
check("login CSP allows the redirect to Claude", /form-action 'self' https:\/\/claude\.ai;/.test(csp), csp.match(/form-action[^;]*/)?.[0]);
const ownerToken = newToken(OWNER);
check("invalid session length refused", (await submit(first.loginId, ownerToken, "1000")).status === 400);
const badTok = await submit(first.loginId, randomUUID(), "30");
check("unknown Wise token refused, can retry", badTok.status === 401 && (await badTok.text()).includes("Wise rejected this token"));
check("garbage token refused", (await submit(first.loginId, "x y", "30")).status === 400);

// --- Allowlist --------------------------------------------------------------------------
const stranger = await openLogin();
const strangerToken = newToken(STRANGER);
const refused = await submit(stranger.loginId, strangerToken, "30");
check("other Wise users refused", refused.status === 403 && (await refused.text()).includes(`ALLOWED_WISE_USERS=${STRANGER}`));
check("nothing kept for refused user", storedConnections() === 0);
check("login id is single-use after refusal", (await submit(stranger.loginId, ownerToken, "30")).status === 400);

// --- Tokens & sessions --------------------------------------------------------------------
const ok1 = await submit(first.loginId, ownerToken, "never");
const loc = new URL(ok1.headers.get("location")!);
check("login redirects to Claude with code + state", ok1.status === 302 && loc.origin + loc.pathname === REDIRECT && loc.searchParams.get("state") === "s1");
check("login id is single-use", (await submit(first.loginId, ownerToken, "never")).status === 400);
const tok = await finishLogin(first.verifier, ok1);
check("tokens issued", !!tok.access_token && !!tok.refresh_token && tok.expires_in === 3600);
const refresh = (rt: string) => fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: client.client_id }) });
const ref: any = await refresh(tok.refresh_token).then((r) => r.json());
check("refresh token rotation works", !!ref.access_token && ref.refresh_token !== tok.refresh_token);
check("old refresh token rejected", (await refresh(tok.refresh_token)).status === 400);
check("old access token still valid until expiry", (await fetch(`${B}/mcp`, { method: "GET", headers: { authorization: `Bearer ${tok.access_token}` } })).status === 405);

const secondToken = newToken(OWNER); // a second Wise token for the same user
const shortTok = await login(secondToken, "5");
const saved = JSON.parse(readFileSync(path.join(DATA, "oauth-sessions.json"), "utf8"));
const lengths = Object.values<any>(saved.sessions).map((s) => (s.expiresAt === null ? null : Math.round((s.expiresAt - s.createdAt) / 86_400_000)));
check("session lengths stored", lengths.includes(null) && lengths.includes(5), JSON.stringify(lengths));
check("short session's refresh token expires with it", Object.values<any>(saved.tokens).some((t) => t.kind === "refresh" && t.expiresAt !== null));
check("raw OAuth tokens not on disk", ![tok.access_token, ref.access_token, ref.refresh_token].some((t) => JSON.stringify(saved).includes(t)));

const onDisk = readdirSync(DATA, { recursive: true }).map((f) => { try { return readFileSync(path.join(DATA, String(f)), "utf8"); } catch { return ""; } }).join("\n");
check("state files are owner-only, no temp files left", (await Promise.all([DATA, path.join(DATA, "oauth-sessions.json"), path.join(DATA, "wise", "connections.json")].map(hasPrivatePermissions))).every(Boolean) && !readdirSync(DATA, { recursive: true }).some((f) => String(f).endsWith(".tmp")));
check("Wise tokens encrypted at rest", !onDisk.includes(ownerToken) && !onDisk.includes(secondToken) && onDisk.includes('"token": "v1.'));

// --- MCP tools ------------------------------------------------------------------------------
let id = 0;
const rpc = async (token: string, method: string, params: unknown): Promise<any> => {
  const t = await fetch(`${B}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }).then((r) => r.text());
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : t);
};
const call = async (token: string, name: string, args: object) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  let json: any;
  try { json = JSON.parse(text); } catch { /* error text */ }
  // Every successful call must carry structuredContent (validated by the SDK against the tool's output schema).
  if (r.result && !r.result.isError) structuredCalls.push(JSON.stringify(r.result.structuredContent) === JSON.stringify(json) ? "ok" : name);
  if (r.error) structuredCalls.push(`${name}: ${r.error.message}`);
  return { isError: !!r.result?.isError, text, json };
};
const structuredCalls: string[] = [];
const T = ref.access_token;
const init = await rpc(T, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
check("serverInfo has Wise title + icon", init.result?.serverInfo?.title === "Wise" && init.result?.serverInfo?.icons?.[0]?.src === `${B}/icon.png`);
const tools = await rpc(T, "tools/list", {});
const names = (tools.result?.tools ?? []).map((t: any) => t.name).sort();
const expectedTools = ["confirm_action", "discard_action", "get_exchange_rate", "get_quote", "get_recipient_requirements", "get_transactions", "get_transfer", "list_balances", "list_profiles", "list_recipients", "list_transfers", "prepare_cancel_transfer", "prepare_recipient", "prepare_transfer"];
check("read + two-step write tools", JSON.stringify(names) === JSON.stringify(expectedTools), names.join(","));
check("every tool has an output schema and described parameters", (tools.result?.tools ?? []).every((t: any) => t.outputSchema?.type === "object" && Object.values(t.inputSchema?.properties ?? {}).every((p: any) => p.description)), (tools.result?.tools ?? []).filter((t: any) => !t.outputSchema).map((t: any) => t.name).join(","));
check("only confirm/discard are non-readOnly", (tools.result?.tools ?? []).filter((t: any) => t.annotations?.readOnlyHint !== true).map((t: any) => t.name).sort().join() === "confirm_action,discard_action");

const profiles = await call(T, "list_profiles", {});
check("list_profiles", !profiles.isError && profiles.json.profiles.length === 2 && profiles.json.profiles[1].name === "BlanketByte SRL");

const balances = await call(T, "list_balances", {});
check("list_balances: all profiles, jars, empty hidden", !balances.isError && balances.json.balances.length === 3 && balances.json.balances.some((b: any) => b.kind === "jar" && b.name === "No More Debts" && b.amount === 15.71) && balances.json.balances.some((b: any) => b.profile.id === BUSINESS && b.amount === 94.69));
check("reserved money is explained in the result", balances.json.balances.some((b: any) => b.reserved === 153.7 && b.note?.includes("already deducted from amount") && b.note.includes("559.38 EUR is available")) && balances.json.balances.filter((b: any) => !b.reserved).every((b: any) => !b.note));
const bizBal = await call(T, "list_balances", { profile: "business", include_empty: true });
check("list_balances: profile by type + include_empty", !bizBal.isError && bizBal.json.balances.length === 2 && bizBal.json.balances.every((b: any) => b.profile.id === BUSINESS));
check("unknown profile → helpful error", (await call(T, "list_balances", { profile: "nope" })).text.includes(`${PERSONAL} (PERSONAL`));

const txs = await call(T, "get_transactions", { limit: 4 });
const [coop, payroll, inter, lidl] = txs.json?.transactions ?? [];
check("get_transactions defaults to personal", !txs.isError && txs.json.profile.id === PERSONAL && txs.json.count === 4);
check("HTML stripped, amounts parsed", coop?.title === "Coop" && coop.amount === 24.73 && coop.direction === "out" && coop.secondary_text === "Roundup" && lidl?.title === "Lidl & Co");
check("incoming + neutral + secondary currency", payroll?.direction === "in" && payroll.amount === 4500 && inter?.direction === "neutral" && lidl?.secondary_amount?.currency === "EUR" && lidl.secondary_amount.amount === 20.12);
const page2 = await call(T, "get_transactions", { limit: 4, cursor: txs.json.next_cursor });
check("cursor pagination continues exactly", page2.json?.transactions?.[0]?.id === "act-4");
const big = await call(T, "get_transactions", { limit: 120 });
check("limit > 100 spans pages (size ≤ 100)", big.json?.count === 120 && big.json.transactions[119].id === "act-119" && !!big.json.next_cursor);
const cards = await call(T, "get_transactions", { type: "transfer", limit: 10 });
check("type filter → monetaryResourceType", cards.json?.count === 1 && queries.some((q) => q.searchParams.get("monetaryResourceType") === "TRANSFER"));
await call(T, "get_transactions", { since: "2026-10-09", until: "2026-10-10", limit: 5 });
check("invalid date → clear error", (await call(T, "get_transactions", { since: "2026-13-01" })).text.includes("isn't a valid date"));
check("since/until sent as ISO day bounds", queries.some((q) => q.searchParams.get("since") === "2026-10-09T00:00:00.000Z" && q.searchParams.get("until") === "2026-10-10T23:59:59.999Z"));
const search = await call(T, "get_transactions", { search: "shop 14", limit: 5 });
check("search scans pages", !search.isError && search.json.transactions.some((t: any) => t.title === "Shop 140") && search.json.transactions.every((t: any) => t.title.toLowerCase().includes("shop 14")));
const biz = await call(T, "get_transactions", { profile: BUSINESS });
check("business profile by id", biz.json?.profile?.type === "BUSINESS" && biz.json.transactions[0].title === "AWS");

const tr = await call(T, "list_transfers", {});
check("list_transfers newest first with recipient names", !tr.isError && tr.json.transfers[0].id === 7002 && tr.json.transfers[2].id === 7000 && tr.json.transfers[1].recipient_name === "Mario Rossi" && tr.json.transfers[0].reference === "invoice 42");
check("list_transfers search", (await call(T, "list_transfers", { search: "rent" })).json?.transfers?.length === 1);
const one = await call(T, "get_transfer", { id: 7000 });
check("get_transfer with recipient", !one.isError && one.json.source.amount === 500 && one.json.target.currency === "RON" && one.json.recipient?.name === "Mario Rossi" && one.json.rate === 4.96);
const forbidden = await call(T, "get_transfer", { id: 999 });
check("403 on an endpoint is an error, not a revocation", forbidden.isError && forbidden.text.includes("403") && !(await call(T, "list_profiles", {})).isError);

const rec = await call(T, "list_recipients", {});
check("list_recipients across profiles (both name shapes)", !rec.isError && rec.json.count === 2 && rec.json.recipients.some((r: any) => r.name === "ACME Ltd") && rec.json.recipients.some((r: any) => r.account.startsWith("IT60")));
check("list_recipients search", (await call(T, "list_recipients", { search: "mario" })).json?.count === 1);
const rate = await call(T, "get_exchange_rate", { source: "eur", target: "ron" });
check("get_exchange_rate", !rate.isError && rate.json.rate === 4.9712 && rate.json.source === "EUR");

// --- Writes (two-step) -------------------------------------------------------------------------
const quote = await call(T, "get_quote", { source_currency: "eur", target_currency: "RON", send_amount: 100 });
check("get_quote uses the balance pay-in price", !quote.isError && quote.json.fee.amount === 0.5 && quote.json.target.currency === "RON" && quote.json.delivery === "by <strong>Monday</strong>");
check("get_quote needs exactly one amount", (await call(T, "get_quote", { source_currency: "EUR", target_currency: "RON" })).isError);
const reqs = await call(T, "get_recipient_requirements", { currency: "EUR" });
check("get_recipient_requirements", !reqs.isError && reqs.json.options[0].type === "iban" && reqs.json.options[0].fields.some((f: any) => f.key === "IBAN" && f.required) && headersSeen.minor === "1");

const prepRcp = await call(T, "prepare_recipient", { currency: "EUR", type: "iban", account_holder_name: "Ana Pop", details: { legalType: "PRIVATE", IBAN: "DE89370400440532013000" } });
check("prepare_recipient returns a code, creates nothing", !prepRcp.isError && /^RCP-[0-9A-F]{8}$/.test(prepRcp.json.confirmation_code) && prepRcp.json.summary.includes("Ana Pop") && newRecipients.length === 0);
const confRcp = await call(T, "confirm_action", { confirmation_code: prepRcp.json.confirmation_code });
check("confirm_action creates the recipient", !confRcp.isError && confRcp.json.recipient.id === 503 && newRecipients.length === 1 && newRecipients[0].profile === PERSONAL);
const badRcp = await call(T, "confirm_action", { confirmation_code: (await call(T, "prepare_recipient", { currency: "EUR", type: "iban", account_holder_name: "No Iban", details: { legalType: "PRIVATE" } })).json.confirmation_code });
check("Wise validation errors are passed through", badRcp.isError && badRcp.text.includes("IBAN: Please specify IBAN"));

check("limit enforced (MAX_TRANSFER_AMOUNT)", (await call(T, "prepare_transfer", { recipient_id: 501, send_amount: 5000 })).text.includes("limit"));
const prep = await call(T, "prepare_transfer", { recipient_id: 501, send_amount: 100, reference: "dinner" });
const code = prep.json?.confirmation_code;
check("prepare_transfer: summary + code, nothing created", !prep.isError && /^TX-/.test(code) && prep.json.summary.includes("Mario Rossi") && prep.json.summary.includes('"dinner"') && created.length === 0, prep.json?.summary);
check("prepare_transfer: balance check", prep.json?.balance_check?.startsWith("OK"));
check("another connection can't confirm it", (await call(shortTok.access_token, "confirm_action", { confirmation_code: code })).isError && created.length === 0);
const sameTokenOtherSession = await login(ownerToken, "30");
check("another session with the same token can't confirm it", (await call(sameTokenOtherSession.access_token, "confirm_action", { confirmation_code: code })).isError && created.length === 0);
const conf = await call(T, "confirm_action", { confirmation_code: code });
check("confirm_action creates the transfer unpaid", !conf.isError && conf.json.status === "created_awaiting_payment" && created.length === 1 && created[0].status === "incoming_payment_waiting");
check("transfer uses the quote, reference and an idempotency key", created[0].quoteUuid === prep.json.quote.id && created[0].details.reference === "dinner" && /^[0-9a-f-]{36}$/.test(createCalls[0]));
check("confirmation code is single-use", (await call(T, "confirm_action", { confirmation_code: code })).isError && created.length === 1);

const discard = await call(T, "prepare_transfer", { recipient_id: 501, receive_amount: 20 });
check("receive_amount quotes the target side", discard.json?.quote?.target?.amount === 20);
await call(T, "discard_action", { confirmation_code: discard.json.confirmation_code });
check("discarded action can't be confirmed", (await call(T, "confirm_action", { confirmation_code: discard.json.confirmation_code })).isError && created.length === 1);

const gbp = await call(T, "prepare_transfer", { recipient_id: 502, send_amount: 50 });
check("missing route fields are listed", gbp.isError && gbp.text.includes("transferPurpose") && gbp.text.includes("verification.transfers.purpose.pay.bills"));
const gbp2 = await call(T, "prepare_transfer", { recipient_id: 502, send_amount: 50, extra_details: { transferPurpose: "verification.transfers.purpose.pay.bills" } });
check("recipient's profile is used by default", !gbp2.isError && gbp2.json.summary.includes("business profile"));

const prepCxl = await call(T, "prepare_cancel_transfer", { transfer_id: created[0].id });
check("prepare_cancel_transfer returns a code, cancels nothing", !prepCxl.isError && /^CXL-/.test(prepCxl.json.confirmation_code) && created[0].status === "incoming_payment_waiting");
const cxl = await call(T, "confirm_action", { confirmation_code: prepCxl.json.confirmation_code });
check("confirm_action cancels the unpaid transfer", !cxl.isError && created[0].status === "cancelled");
const odd = await call(T, "prepare_transfer", { recipient_id: 501, send_amount: 1.23 });
const oddConf = await call(T, "confirm_action", { confirmation_code: odd.json.confirmation_code });
const oddT = created[created.length - 1];
check("amount mismatch → transfer auto-cancelled, clear error", oddConf.isError && oddT.targetValue === 0.05 && oddT.status === "cancelled" && oddConf.text.includes("recipient gets 0.05 EUR instead of the approved 0.73 EUR") && oddConf.text.includes("cancelled automatically"), oddConf.text);
check("quotes ask for BALANCE pricing", quoteBodies.length > 0 && quoteBodies.every((b) => b.preferredPayIn === "BALANCE"));
check("summary shows the balance price", prep.json.quote.pay_in === "BALANCE" && prep.json.quote.fee.amount === 0.5 && prep.json.summary.includes("when paid from your Wise balance") && prep.json.quote.pay_in_options.length === 2 && prep.json.quote.pay_in_options[0].pay_in === "BALANCE", prep.json.summary);
check("unpaid bank-transfer price is accepted and explained", !conf.isError && created[0].targetValue === 99.2 && conf.json.wise_shows_until_paid.startsWith("99.20 EUR") && conf.json.note.includes("re-prices") && conf.json.note.includes("99.50 EUR"), JSON.stringify(conf.json));
check("paid transfers can't be cancelled", (await call(T, "prepare_cancel_transfer", { transfer_id: 7000 })).text.includes("incoming_payment_waiting"));

check("every successful call returned valid structuredContent", structuredCalls.length > 20 && structuredCalls.every((x) => x === "ok"), structuredCalls.filter((x) => x !== "ok").join("; "));

const auditLog = readFileSync(path.join(DATA, "audit.log"), "utf8");
check("audit log records every write", ["recipient_prepared", "recipient_created", "transfer_prepared", "transfer_created", "action_discarded", "transfer_cancelled", "transfer_amount_mismatch"].every((e) => auditLog.includes(`"${e}"`)) && !auditLog.includes(ownerToken));

// --- /sessions -------------------------------------------------------------------------------
const noCookie = await fetch(`${B}/sessions`).then((r) => r.text());
check("/sessions requires a Wise token", noCookie.includes('action="/sessions/login"') && !noCookie.includes("Revoke all"));
check("/sessions refuses unknown token", (await fetch(`${B}/sessions/login`, { method: "POST", body: new URLSearchParams({ token: randomUUID() }), redirect: "manual" })).status === 401);
check("/sessions refuses other Wise users", (await fetch(`${B}/sessions/login`, { method: "POST", body: new URLSearchParams({ token: strangerToken }), redirect: "manual" })).status === 403);
const adminRes = await fetch(`${B}/sessions/login`, { method: "POST", body: new URLSearchParams({ token: ownerToken }), redirect: "manual" });
const cookie = adminRes.headers.get("set-cookie")!.split(";")[0];
check("/sessions sign-in sets a short cookie", adminRes.status === 303 && /Max-Age=900/.test(adminRes.headers.get("set-cookie")!) && /HttpOnly/i.test(adminRes.headers.get("set-cookie")!));
check("forged cookie rejected", !(await fetch(`${B}/sessions`, { headers: { cookie: `wise_mcp_admin=${OWNER}:${Date.now() + 1e6}.forged` } }).then((r) => r.text())).includes("Revoke all"));
const sessionsHtml = await fetch(`${B}/sessions`, { headers: { cookie } }).then((r) => r.text());
check("/sessions lists all 3 sessions", (sessionsHtml.match(/name="id" value="[0-9a-f]{64}"/g) ?? []).length === 3 && sessionsHtml.includes("Jane Doe"));
check("sessions sign-in didn't store anything", storedConnections() === 2);
const shortId = Object.entries<any>(saved.sessions).find(([, s]) => s.expiresAt !== null)![0];
await fetch(`${B}/sessions/revoke`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ id: shortId }), redirect: "manual" });
check("revoked session's token stops working", (await fetch(`${B}/mcp`, { method: "POST", headers: { authorization: `Bearer ${shortTok.access_token}` } })).status === 401);
check("revoked session's refresh token rejected", (await refresh(shortTok.refresh_token)).status === 400);
check("its now-unused Wise token is deleted", storedConnections() === 1);
check("other session still works", !(await call(T, "list_profiles", {})).isError);

// --- Revocation in Wise ----------------------------------------------------------------------
revoked.add(ownerToken);
const after = await call(T, "list_balances", {});
check("revoked Wise token reported", after.isError && after.text.includes("revoked"), after.text.slice(0, 80));
check("its sessions are removed", (await fetch(`${B}/mcp`, { method: "POST", headers: { authorization: `Bearer ${T}` } })).status === 401);
check("refresh fails after revocation", (await refresh(ref.refresh_token)).status === 400);
check("revoked token deleted from disk", storedConnections() === 0);

// --- Read-only token ---------------------------------------------------------------------------
const roToken = newToken(OWNER);
readOnlyTokens.add(roToken);
const ro = await login(roToken, "30");
const roWrite = await call(ro.access_token, "prepare_transfer", { recipient_id: 501, send_amount: 10 });
check("read-only token: writes explain Full access", roWrite.isError && roWrite.text.includes("Full access"), roWrite.text.slice(0, 90));
check("read-only token: still connected and reading", !(await call(ro.access_token, "list_profiles", {})).isError);

// --- Rate limiting on the token forms ---------------------------------------------------------
let limited = false;
for (let i = 0; i < 25 && !limited; i++) {
  limited = (await fetch(`${B}/sessions/login`, { method: "POST", body: new URLSearchParams({ token: "x" }), redirect: "manual" })).status === 429;
}
check("token forms are rate-limited per IP", limited);

console.log(process.exitCode ? "\nSome checks failed" : "\nAll checks passed 🎉");
rmSync(DATA, { recursive: true, force: true });
process.exit();
