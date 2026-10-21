# Grok Bot usage

The dashboard polls Grok Bot's separate weekly allowance every five minutes using
`aiserver.v1.DashboardService/GetSandUsageStatus` at the fixed HTTPS origin
`https://api2.cursor.sh`. This is the endpoint used by the installed Grok Bot app.
It is not Cursor's monthly quota, and it does not use the xAI API billing quota.

The existing Cursor login is used only after matching its token subject hash to
Grok Bot's active account scope in `~/.grokbot/settings.json`. Both accounts must
match; each poll checks again, including after the response. Tokens stay in memory
and go only to the provider endpoint; no redirects, token logging, export, refresh,
window observation, or new macOS permissions are used. Cursor owns login refresh.
Team seats and pooled enterprise allowances are not yet supported.

If Cursor's closed database cannot open read-only without creating sidecars, a
read-only immutable query is allowed only when no WAL/rollback journal exists.
The result is rejected if a journal appears or the file size/mtime changes during
the query. No database files are changed or copied.

The last successful usage is cached like other tools. Errors, login unavailability,
account mismatch, rate limits, and data older than 15 minutes are not shown as fresh.
Set `GROK_USAGE=off` to disable polling. The existing Cursor >=98% Other models rule
and the daily 06:00 review window are unchanged.

Verified Oct 4, 2026: matching active account, HTTP 200 and 5.435094% from the real
Grok endpoint. Earlier user screenshot showed 4%; it is an older reading, not an
exact simultaneous comparison. UI tests used synthetic data at 834x1194, 1194x834,
and 1440x900; none overflowed or clipped usage labels. These are viewport simulations,
not physical iPad tests.

Tests: `test-grok-usage.js`, `test-usage-login.js`, `test-cursor-usage.js`,
`test-daily-review.js`, `test-connections.js`, `test-server-state.js`,
`test-approval-state.js`, `test-coverage-state.js`, `test-codex-recovery.js`.
