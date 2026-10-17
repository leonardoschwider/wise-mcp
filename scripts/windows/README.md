# Windows Wise MCP — Temporary Beelink Setup

This is the temporary Windows host for the personal Wise MCP fork. The real Wise API token must **never** be pasted into chat, stored in Git, written in Executor connector JSON, or passed on a command line.

## Set up a token (interactive)

Open PowerShell **as the same Windows user that will run the MCP**:

```powershell
cd C:\Users\Leonardo\Documents\Repositories\wise-mcp
.\scripts\windows\set-wise-token.ps1
```

Paste the token at the **hidden** prompt. The script saves an encrypted DPAPI credential to `%LOCALAPPDATA%\WiseMCP\wise-api-token.dpapi` and restricts its directory ACL to the current user, SYSTEM, and Administrators.

## Verify access

```powershell
.\scripts\windows\start-wise-mcp.ps1 -Mode check
.\scripts\windows\start-wise-mcp.ps1 -Mode verify
```

`check` verifies that the credential can be decrypted under the current Windows identity, without contacting Wise. `verify` makes one authenticated GET to Wise's `/v1/me` endpoint and reports only success or the HTTP status. Do not use `verify` until a real token has been saved.

## Run as a local MCP

Build once with `npm ci --ignore-scripts` and `npm run build`. The future MCP launcher command is:

```powershell
pwsh -NoProfile -File "C:\Users\Leonardo\Documents\Repositories\wise-mcp\scripts\windows\start-wise-mcp.ps1"
```

The launcher injects the decrypted token into **only its child process**, forces `WRITES_ENABLED=false`, pins the Wise API endpoint to `https://api.wise.com`, and puts private audit data under `%LOCALAPPDATA%\WiseMCP\data`. It does **not** register an Executor CLI connection by itself.

## Limitations

DPAPI is tied to the current **Windows user** and machine; the encrypted file will not work on macOS or another Windows identity. When migrating to the MacBook, provision its token separately through a secure credential manager.

The default MCP exposes **9 informational tools**, including quote creation and recipient-field requirements. These two endpoints create temporary quotes and may require API capabilities not granted to a strictly read-only Wise token. No transfer, recipient creation, or cancellation tools are exposed.
