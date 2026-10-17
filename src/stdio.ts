import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { ensurePrivateDataDir } from "./fsutil.js";
import { PUBLIC_DIR, VERSION, WEBSITE } from "./meta.js";
import { registerTools } from "./tools.js";
import { WiseAccessRevokedError, WiseApiError, WiseClient } from "./wise/client.js";
import { WiseService } from "./wise/service.js";

/**
 * Local mode: speaks MCP over stdin/stdout for Claude Desktop, Claude Code, Cursor, etc.
 * No OAuth or sessions: the Wise token comes from WISE_API_TOKEN in the app's MCP config.
 * stdout carries the protocol, so everything else goes to stderr.
 *
 * Without a token the server still starts and lists its tools (so directories like Glama can
 * inspect it); every tool call then explains how to set WISE_API_TOKEN.
 */
const log = (msg: string) => process.stderr.write(`[wise-mcp] ${msg}\n`);

const MISSING_TOKEN =
  "WISE_API_TOKEN is not set. Create a token in Wise → Settings → API tokens and add it to this server's env in your MCP client config.";

/** Stand-in client used when no token is configured: every Wise call explains what to do. */
class MissingTokenClient extends WiseClient {
  override async request<T>(): Promise<T> {
    throw new Error(MISSING_TOKEN);
  }
}

const token = process.env.WISE_API_TOKEN?.trim();
let client: WiseClient;
if (!token) {
  log(`${MISSING_TOKEN} Starting anyway: tools are listed, but calls will fail until it's set.`);
  client = new MissingTokenClient("", config.WISE_API_URL);
} else {
  client = new WiseClient(token, config.WISE_API_URL);
  try {
    const me = await client.me();
    log(`connected as Wise user ${me.id}`);
  } catch (err) {
    if (err instanceof WiseAccessRevokedError || (err instanceof WiseApiError && err.status === 403)) {
      log("Wise rejected WISE_API_TOKEN. Check it's copied fully and not revoked.");
      process.exit(1);
    }
    log(`couldn't reach Wise yet (${err instanceof Error ? err.message : err}); tools will retry`);
  }
}

ensurePrivateDataDir(config.DATA_DIR);

let icons: { src: string; mimeType: string; sizes: string[] }[] = [];
try {
  icons = [{ src: `data:image/svg+xml;base64,${readFileSync(path.join(PUBLIC_DIR, "logo.svg")).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] }];
} catch {
  /* icon is optional */
}

const server = new McpServer({ name: "wise", title: "Wise", version: VERSION, websiteUrl: WEBSITE, icons });
registerTools(server, new WiseService(client), {
  sessionKey: "local",
  connectionId: "local",
  onRevoked: async () => {
    log("Wise rejected the token (revoked or expired). Update WISE_API_TOKEN and restart.");
  },
});
await server.connect(new StdioServerTransport());
log(`ready (v${VERSION}, writes ${config.WRITES_ENABLED ? "enabled, two-step" : "disabled"}, audit log ${path.join(config.DATA_DIR, "audit.log")})`);
