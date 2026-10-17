# macOS / Executor CLI — Pending Activation

This folder prepares the final **MacBook-based Executor CLI deployment**. The current working copy is hosted on the temporary Beelink. Do not register a broken or tokenless integration as Installed.

## Install source and wrapper

After the MacBook is accessible:

```bash
git clone https://github.com/leonardoschwider/wise-mcp.git "$HOME/Documents/Repositories/wise-mcp"
cd "$HOME/Documents/Repositories/wise-mcp"
npm ci --ignore-scripts
npm run build
install -d "$HOME/.local/bin"
install -m 700 scripts/macos/wise-mcp-wrapper "$HOME/.local/bin/wise-mcp-wrapper"
```

If the repository already exists, use `git pull --ff-only` rather than cloning.

## Add token to the macOS Login Keychain

Use the interactive form (no secret in shell arguments or Git):

```bash
security add-generic-password -a "$USER" -s "wise-mcp-api-token" -l "Wise MCP API token" -U -w
```

The `-w` **last** prompts for the token interactively. If using a truly read-only API token, note that quote-estimation endpoints create temporary quotes and might fail even though 7 GET-only tools still work.

## Register with Executor CLI

Use a new native local command/stdio service named **wise**, connection **default**, launched by:

```
$HOME/.local/bin/wise-mcp-wrapper
```

The wrapper loads the secret from Keychain and forces `WRITES_ENABLED=false`. Use Executor CLI's current integration-registration mechanism; do not paste the token into an integration definition. Live registration is pending until Executor CLI is reachable and the token is provisioned.

## Validate after authentication

- Wrapper launch: MCP initialize and tools/list => **9 tools**.
- Read-only calls: list_profiles, list_balances, get_transactions, list_transfers, get_transfer, list_recipients, get_exchange_rate.
- Informational operations: get_quote and get_recipient_requirements (may need quote API privileges).
- Explicitly verify that prepare_recipient, prepare_transfer, prepare_cancel_transfer, confirm_action, discard_action are **not** in the exposed tool list.
- Validate the integration in Executor CLI; only then mark the AI / Executor registry record **Installed**.
- Never run real transfers or mutations as part of testing.

Keep the Beelink token separate. Its Windows DPAPI credential cannot be decrypted on macOS.
