/**
 * Minimal Wise API client for a personal API token (https://docs.wise.com/guides/developer/auth-and-security/personal-api-token).
 */

export class WiseApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "WiseApiError";
  }
}

/** Wise no longer accepts the token (revoked or expired in Wise → Settings → API tokens). */
export class WiseAccessRevokedError extends Error {
  constructor() {
    super("The Wise API token was revoked or has expired. Create a new token in Wise and reconnect (or update WISE_API_TOKEN when running locally).");
    this.name = "WiseAccessRevokedError";
  }
}

export interface WiseMe {
  id: number;
  name?: string;
  email?: string;
  active?: boolean;
}

type Query = Record<string, string | number | undefined>;
interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Safe to resend after a 5xx/timeout (GETs, or POSTs carrying an idempotency key). */
  idempotent?: boolean;
}

const TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WiseClient {
  constructor(
    private token: string,
    private baseUrl: string,
  ) {}

  get<T = any>(path: string, query: Query = {}, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { query, headers, idempotent: true });
  }

  post<T = any>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  put<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body, idempotent: true });
  }

  me(): Promise<WiseMe> {
    return this.get<WiseMe>("/v1/me");
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "error", // Do not follow redirects when an Authorization header is present.
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "User-Agent": "wise-mcp",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (opts.idempotent && attempt < 1) continue;
        throw err;
      }
      // 429 means the request wasn't processed, so it's always safe to retry.
      if (res.status === 429 && attempt < 2) {
        await sleep(Math.min(10, Number(res.headers.get("retry-after")) || 2) * 1000);
        continue;
      }
      if (res.status >= 500 && opts.idempotent && attempt < 1) {
        await sleep(1000);
        continue;
      }
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

      if (res.status === 401) throw new WiseAccessRevokedError();
      if (res.status === 403 && path !== "/v1/me" && (await this.isRevoked())) throw new WiseAccessRevokedError();
      let message = errorMessage(text, res.status);
      if (res.status === 403) {
        if (res.headers.get("x-2fa-approval")) {
          message += " — Wise requires strong customer authentication for this, which a personal token can't complete here. Do it in the Wise app.";
        } else if (method !== "GET") {
          message += " — if your token is Read only, create a Full access token in Wise and reconnect.";
        }
      }
      throw new WiseApiError(res.status, `Wise API ${res.status} on ${method} ${path}: ${message}`);
    }
  }

  /** A 403 can mean "not allowed for this token" or "token revoked": ask /v1/me. */
  private async isRevoked(): Promise<boolean> {
    try {
      await this.me();
      return false;
    } catch (err) {
      return err instanceof WiseAccessRevokedError || (err instanceof WiseApiError && err.status === 403);
    }
  }
}

function errorMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.errors) && j.errors.length) {
      return j.errors.map((e: any) => [e.path || e.field, e.message ?? e.code].filter(Boolean).join(": ")).join("; ");
    }
    return j.message ?? j.error_description ?? j.error ?? `HTTP ${status}`;
  } catch {
    return status === 403 ? "forbidden (not available for this token)" : `HTTP ${status}`;
  }
}
