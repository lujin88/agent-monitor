# Agent Monitor connection audit — 2026-09-30

“Monitor online” confirms only that this page can reach the local server. It does not imply every provider, notification destination, or approval integration works.

| Channel | Observed result | What remains |
| --- | --- | --- |
| Dashboard API and authentication | Live authenticated state read and event round trip passed | No known transport failure |
| Codex task lifecycle | Real task events present; six runtime hooks enabled and trusted; log recovery tests passed | Preserve native approval fallback |
| Claude Code task lifecycle | Hooks installed; previously received a real completed task | A fresh task is needed to verify current application delivery |
| Cursor task lifecycle | Start/stop hooks configured; user confirms Cursor was not used today | No event is expected today; this is not evidence of missing data |
| Codex usage | Live account query succeeded; recent timestamp | Polls every five minutes |
| Cursor usage | Live query succeeded; primary pool 98.93%, Other models 27.04% at audit time | 98% boundary behavior tested; values naturally change |
| Claude usage | Existing data approximately 7.8 hours old at 17:35 CEST | Comes from Claude Code status-line events, not the ordinary Claude chat app; shown as cached |
| Ordinary Claude / ChatGPT / Grok chats | Installed observer still returns permission_required | Replace the old Accessibility entry with /Users/lu/agent-monitor/ChatObserver.app; then verify a real start and finish |
| Grok Bot | Desktop app identified as com.anysphere.sand; not Grok Build CLI | Shares the ordinary-chat observer permission blocker |
| Grok independent usage | No integration | Cursor Other models is not evidence of an independent Grok subscription quota |
| Dashboard approval | Real harmless command resumed after user clicked Approve; user confirmed success | Single-click approval verified for Codex; six isolated Codex/Claude decision round trips also passed |
| Notifications | Browser permission/sound state now visible in Connections | Native notification submission is not proof the OS displayed it; delivery remains unverified |

## Repairs from this audit

- Send native notifications for ordinary needs_action transitions, with repeated-status deduplication; expose submission status separately from delivery.
- Preserve Codex thread_id in status events instead of merging those events into the default session.
- Show cached usage explicitly; retain the Cursor >=98% switch to Other models.
- Separate local server reachability from provider connection status.
- Extend doctor.js to fail on blocked chat access and stale usage, and identify unverified channels instead of reporting all clear.
- Add regression tests for task identity and connection status.

Seven existing regression suites passed. New tests exercise the actual notify.js request payload and dashboard connection/usage functions. Browser visual verification was unavailable because the browser tool could not verify its required policy; this report does not claim a fresh visual pass.

No real approval was issued automatically, no message was sent to an AI app for testing, and no Accessibility permission was changed by the audit.

## Follow-up audit — 17:35 CEST

- Live API returned HTTP 200. Both active Codex lifecycle records were represented in the dashboard: one running and one awaiting approval. No current Codex task omission was found.
- Codex and Cursor usage were refreshed within four minutes; Claude usage was 467 minutes old.
- The observer still reported `permission_required`, `accessGranted: false`, and zero observed windows. Ordinary-chat coverage remains blocked despite the enabled-looking macOS entry.
- Native notification submission succeeded; actual notification display is unverified.
- The monitor stores the latest state per conversation, not an event history. A new turn replaces the previous turn's state. Completed sessions are retained for seven days or until dismissed. Hooks have no durable offline retry queue, so events while the server is down can be lost; Codex log reconciliation offers partial recovery. This audit cannot certify historical completeness.
- A regression check reproduced an additional defect: 30 minutes of silence marked a task complete. The fix marks it `unobserved`, keeps the last activity timestamp, and restores running status on the next tool activity. Explicit completion still marks it done.

Cursor inactivity was confirmed by the user; no Cursor test prompt was sent. No real approval was issued by the audit.

## Final layout and connection check — 2026-10-01

### Shipped
- Reduced the desktop title to 28px and header allocation to 44px; removed the Live activity empty message. Empty action/activity panels have no card or filler text.
- Fixed narrow, short windows: title and status use separate rows, header buttons stay reachable, usage cells stack their own content instead of retaining desktop widths, and approval controls occupy a separate row.
- Reclaimed mobile usage height so a running task's title, activity count and update time fit.
- Installed HTML was compared byte-for-byte with the HTTP response. No server restart or real approval action was performed. Refresh existing tabs to load the new styles.

### Verification
- Browser DOM checks sampled widths 320, 390, 768, 1024, 1440, and 1920 plus a short 900px-wide window; no page overflow or measured heading/usage text overflow in those samples. Actual viewport sizes differed from the requested sizes because of browser chrome.
- Visually inspected the narrow page and its Review, Running, and real pending approval card. Rechecked running-card clipping after tightening usage height.
- Viewport overrides did not persist reliably across browser calls; a complete repeatable desktop screenshot matrix is not claimed. The override was reset.
- Three-provider, many-task pagination is covered by isolated DOM tests (mocked layout measurements), not a real three-provider activity session. Opening the standalone simulation file was blocked by the browser's file-protocol policy; no workaround was attempted.
- Frontend approval clicks, connection status, Cursor 98% selection, grouped activity, local progress, stale status, observer state/launch, hook identity, server lifecycle, approval round trips and notification deduplication passed.
- The local-recovery integration test initially timed out twice, then passed with diagnostic phase logging. No reproducible product defect was isolated; intermittent recovery-test timing remains a validation limitation.

### Live channel findings
- Authenticated dashboard state is reachable. The current Codex task and real local completed-action count appear in the page.
- Codex and Cursor quota polls report OK, refreshed within five minutes. Cursor's primary pool is above 98%; the displayed quota correctly uses Other models.
- Claude quota is still cached, approximately 23 hours old. Its existing integration depends on Claude Code status-line events; ordinary Claude desktop activity does not refresh it.
- Ordinary-chat observation remains blocked: permission_required, accessGranted=false, zero observed windows. Claude/ChatGPT/Grok ordinary chat tracking cannot be certified until macOS grants the installed ChatObserver.app effective Accessibility access. The monitor cannot grant this permission itself.
- Codex six hooks, Claude seven monitor commands, and Cursor two hooks remain configured with absolute runtime paths. No fresh Cursor/Claude test prompt was sent; configuration is not proof of an end-to-end lifecycle today.
- Notifications are submitted, but actual OS delivery is unverified. Independent Grok quota is not integrated.
- Historical completeness is not guaranteed: no durable offline event queue; the dashboard retains the latest conversation state rather than a full event history.

## Claude quota polling added — 2026-10-01

Added a five-minute quota poll using the standard local Claude Code login and the fixed Anthropic HTTPS usage endpoint. Tokens are read into memory only; no redirects, credential logging, or credential rotation. Connections now offers Refresh Claude usage and explicit sign-in/error states. Last installation check: auth_required. Successful live quota retrieval is not claimed unless status is ok. Claude desktop chat observation remains a separate Accessibility-dependent channel.
