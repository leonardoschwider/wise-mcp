import { z } from "zod";

/** Settings shared by both modes: local (stdio) and remote server. */
const baseSchema = z.object({
  // Account-changing tools (recipients, transfer creation, cancellation) require explicit opt-in.
  // false = 9 informational tools, including 2 that create temporary quotes at Wise.
  WRITES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Optional max amount per transfer, in the source currency. Empty = no limit.
  MAX_TRANSFER_AMOUNT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), "MAX_TRANSFER_AMOUNT must be a positive number"),

  // Where state lives; the audit log is written here in both modes.
  DATA_DIR: z.string().default("./data"),

  // Prevent accidentally sending financial credentials to a custom remote endpoint.
  // Tests may use an explicit loopback-only override; production stays pinned to Wise.
  WISE_API_URL: z.string().url().default("https://api.wise.com").refine((value) => {
    const url = new URL(value);
    const noExtras = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    if (url.origin === "https://api.wise.com" && noExtras) return true;
    return process.env.WISE_MCP_TEST_MODE === "true" && noExtras &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      (url.protocol === "http:" || url.protocol === "https:");
  }, "WISE_API_URL must be https://api.wise.com (only loopback mock URLs are permitted in test mode)"),
});

/** Settings only the remote (HTTP) server needs. */
const serverSchema = z.object({
  // Public HTTPS URL of this server, e.g. https://wise.example.com (no trailing slash)
  PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),

  // Comma-separated Wise user ids allowed to log in. Empty = nobody (the login error shows your id).
  ALLOWED_WISE_USERS: z.string().default(""),
  // Encrypts stored Wise API tokens in DATA_DIR. openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY: z.string().min(32, "TOKEN_ENCRYPTION_KEY must be at least 32 characters"),

  // Redirect hosts allowed during dynamic client registration
  ALLOWED_REDIRECT_HOSTS: z.string().default("claude.ai,claude.com,chatgpt.com,localhost,127.0.0.1"),
});

function parse<T extends z.ZodType>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const base = parse(baseSchema);
export const config = { ...base, WISE_API_URL: base.WISE_API_URL.replace(/\/+$/, "") };

export function loadServerConfig() {
  const server = parse(serverSchema);
  return {
    ...config,
    ...server,
    PUBLIC_URL: server.PUBLIC_URL.replace(/\/+$/, ""),
    allowedWiseUsers: list(server.ALLOWED_WISE_USERS).map(Number).filter(Number.isFinite),
    allowedRedirectHosts: list(server.ALLOWED_REDIRECT_HOSTS),
  };
}
