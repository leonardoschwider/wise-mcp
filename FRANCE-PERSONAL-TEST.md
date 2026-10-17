# Wise Personal Account — France / EU Read-Only Test

**Status:** Offline tooling ready. Live Wise API permissions are **not yet verified**. Do not conclude that a personal account is unsupported just because a balance statement returns 403.

## What research established

- This is a **French/EU Wise personal account**, not a Brazilian Wise account.
- Wise's 2026 developer docs now describe new personal API tokens mainly for **Wise Business** accounts.
- For Wise personal accounts in Europe, SCA request signing for **balance statements** is no longer supported. See [Sure issue #3944](https://github.com/we-promise/sure/issues/3944) and [Wise token documentation](https://docs.wise.com/guides/developer/auth-and-security/personal-api-token).
- [Sure issue #4143](https://github.com/we-promise/sure/issues/4143), October 2026, specifically reports that **personal EU/UK tokens can still access the activity feed** containing `CARD_PAYMENT`, `CASH_WITHDRAWAL`, `DIRECT_DEBIT_TRANSACTION`, `BALANCE_DEPOSIT`, `TRANSFER` and more. Our `get_transactions` tool already uses this feed instead of balance statements.
- Neither Wise's official Open Banking interface nor PSD2 regulation directly grants unlicensed developers access. A licensed AISP/TPP or an established connection provider is needed if the token route fails.

## First test (no writes, no personal data printed)

### Temporary Beelink

```powershell
cd C:\Users\Leonardo\Documents\Repositories\wise-mcp
pwsh -NoProfile -File .\scripts\windows\set-wise-token.ps1
pwsh -NoProfile -File .\scripts\windows\start-wise-mcp.ps1 -Mode diagnose
```

### MacBook (target)

Follow `scripts/macos/README.md` to clone, build and store the token in Keychain, then:

```bash
~/.local/bin/wise-mcp-wrapper --diagnose
```

This checks **GET-only** endpoints: identity, profiles, balances, Jars, activity/card transactions, transfers, recipients and exchange rates. It prints only HTTP status codes and OK/RESTRICTED/FAILED, not financial data, names, tokens, or profile IDs.

**Never paste the API token in ChatGPT**, a Git issue, a shell command argument, or Executor configuration.

## Interpreting results

- **200 for profiles + activities:** Personal API access to core transactions is promising. Next, query `get_transactions` through the MCP to confirm complete coverage. Specifically compare card payments, incoming transfers and conversions without exporting files.
- **403 for balances/statements but 200 for activities:** Useful partial integration. Clearly label unsupported reads; do not claim complete history.
- **401 for identity:** Token invalid, expired or no longer authorized; do not enable write access.
- **All 403:** Token route is likely unsuitable; investigate a licensed EU Open Banking/AISP intermediary.
- **Do not create quotes, recipients, or transfers** during initial authorization diagnostics.

## Alternative — PSD2 Open Banking

Wise publishes a regulated AISP interface (https://docs.wise.com/guides/developer/open-banking). EU personal accounts may be accessible through a licensed aggregator, such as Enable Banking or GoCardless Bank Account Data, subject to **actual Wise France support, pricing, eligibility, and consent**. This is not a direct public developer API and may require periodic customer re-authorization.

Pluggy documents a Wise connector, but I have **not independently verified** that its connector accepts a Wise Europe account established in France. Do not install or pay for a Brazil-focused alternative on that assumption.

## Definition of success

An MCP agent can automatically retrieve fresh, correctly attributed transactions (including card purchases and inbound transfers) from the **authorized** Wise account, without CSV exports, with no financial writes and no long-lived plain-text secret. Unsupported endpoints are reported explicitly rather than silently omitted.
