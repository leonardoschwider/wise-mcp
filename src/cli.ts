#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { VERSION } from "./meta.js";

const HELP = `wise-mcp ${VERSION} — MCP server for Wise

Usage:
  wise-mcp            Run locally over stdio (Claude Desktop, Claude Code, Codex, Cursor…)
  wise-mcp serve      Run the remote HTTP server (OAuth, for Claude and ChatGPT custom connectors)

Local mode env:
  WISE_API_TOKEN       Wise personal API token (required for tool calls)
  WRITES_ENABLED       false = 9 info tools (default, includes temporary quotes); true enables two-step actions
  MAX_TRANSFER_AMOUNT  optional max per transfer, in the source currency
  DATA_DIR             where the audit log is written (default ~/.wise-mcp)

Docs: https://github.com/BlanketByte/wise-mcp`;

const cmd = process.argv[2];
if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
} else if (cmd === "-v" || cmd === "--version") {
  console.log(VERSION);
} else if (cmd === "serve") {
  await import("./index.js");
} else if (cmd === undefined || cmd === "stdio") {
  process.env.DATA_DIR ??= path.join(os.homedir(), ".wise-mcp");
  await import("./stdio.js");
} else {
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(1);
}
