# Wise MCP — Deployment & Handoff

_Last prepared: 2026-10-17. This is a personal fork of BlanketByte/wise-mcp (MIT)._

## Deployment status

| Step | State | Evidence / remaining work |
| --- | --- | --- |
| 1. Upstream audit | Complete | MIT license; authentication, API, tools reviewed |
| 2. Fork | Complete | https://github.com/leonardoschwider/wise-mcp |
| 3. Working copy | Complete (temporary) | `C:\Users\Leonardo\Documents\Repositories\wise-mcp` on Beelink |
| 4. Security audit | Complete (source-level) | Windows ACL fix; dependency audit; test coverage |
| 5. Harden fork | Complete | Nine default informational tools, five action-related tools opt-in; logging and endpoints hardened |
| 6. Secure authentication | Prepared; **pending real token** | Windows DPAPI helper; macOS Keychain wrapper staged; no real token configured |
| 7. Executor CLI registration | **Pending** | CLI connection unavailable; do not mark as Installed |
| 8. Tools verification | Offline tests complete; **live tests pending** | Full `npm test` runs mock Wise API with 14 tools and default 9-tool safe mode |
| 9. Documentation & registry | Prepared | README, host guides, this checklist; AI → Executor table records uninstalled `wise` |

## Security and feature policy

Default `WRITES_ENABLED=false` registers nine informational tools:
`list_profiles`, `list_balances`, `get_transactions`, `list_transfers`,
`get_transfer`, `list_recipients`, `get_exchange_rate`,
`get_quote`, `get_recipient_requirements`.

**Important:** The last two create temporary quotes on Wise via an HTTP POST. They do not create recipients, create transfers, cancel transfers, or move funds, but may need additional API permissions and leave a temporary quote with Wise.

Five additional tools are unavailable unless `WRITES_ENABLED=true`:
`prepare_transfer`, `prepare_recipient`, `prepare_cancel_transfer`,
`confirm_action`, `discard_action`. Do **not** enable these for the personal deployment without a separate approval and live-permission assessment.

- API endpoint pinned to `https://api.wise.com`; local mock overrides require explicit test mode.
- HTTP redirects blocked on authenticated Wise requests.
- Sensitive bank details, free-text summaries, and confirmation codes filtered from audit logs.
- Wise credentials must stay out of source control, terminal command arguments and Executor integration JSON.
- Windows local data is protected by restrictive NTFS ACLs, and its token by current-user DPAPI.
- macOS wrapper reads the token from macOS Keychain and forces safe mode.
- Source repo/public GitHub mirror holds **no runtime secrets**.

## Temporary Beelink

See [Windows instructions](scripts/windows/README.md). Source and compiled executable are on Beelink. Credential enrollment needs the user's hidden prompt, and testing must occur under the same Windows account that stores the DPAPI token.

Without a real token, run:

```powershell
npm ci --ignore-scripts
npm test
npm run build
```

The tests use a local mock Wise API: **no real account mutation or money movement**.

## Target MacBook (Executor CLI)

See [macOS instructions](scripts/macos/README.md). Staged wrapper:
`scripts/macos/wise-mcp-wrapper`. Intended installed path:
`~/.local/bin/wise-mcp-wrapper`. Intended integration slug: `wise`.
Connection name: `default`.

Once the MacBook/Executor CLI is reachable and authentication is configured:

1. Clone/pull fork and build on MacBook.
2. Store the token in macOS Login Keychain using the documented interactive prompt.
3. Install the staged wrapper into `~/.local/bin` and register it as a local **stdio** Executor CLI integration.
4. Verify 9 default tools and test only authorized/read-only Wise API operations.
5. Confirm all five account-changing tools are absent, then mark the Airtable record Installed and link its wrapper record if applicable.

## Wise API compatibility

Wise's current personal-token documentation targets **Wise Business accounts** and lists limited supported endpoints. Some features (particularly balances and activity) may be unavailable to this account/token or region even if they pass mock tests. Do not claim 9 production-working tools until each is tested against the real authorized account.

Reference: https://docs.wise.com/guides/developer/auth-and-security/personal-api-token

## Completion criteria

**Only consider this integration finished** once MacBook and Executor CLI registrations work, a real token is securely stored, all nine informational tools have documented live outcomes (including unsupported endpoints), and the AI → Executor Airtable registry accurately reflects the installed surface and tool count. Do not test financial writes without fresh, explicit authorization.
