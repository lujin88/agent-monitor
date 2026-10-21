# Backend completion — independent review, 2026-10-05

Claude Code implemented the changes on the source-only branch `claude/backend-completion`, based on `fc4fd1a`. Its original delivery is commit `3d85bca`; its report is `BACKEND_COMPLETION_CLAUDE.md`. That report describes the initial implementation and explicitly says tests were not run by Claude. This document describes the reviewed final behavior and supersedes that report where they differ.

## Final changes

- **Approval receipt:** the hook flushes one allow/deny decision to stdout, then confirms receipt with a request-bound secret over the authenticated, loopback-only `/ack` endpoint. Secrets never enter `/state` or persisted state. Missing, wrong, replayed, late, disconnected and legacy receipts cannot report confirmed success. Newer task events are not overwritten by old receipts.
- **Truthful compatibility:** `/decide` returns `ok: true` only for `confirmed` or `released`; `unconfirmed` and `unsupported` return `ok: false` with their explicit delivery outcome. Older open pages therefore cannot mistake an unconfirmed result for success. Updated pages close a terminal, already-sent request with an English warning, without calling it approved or inviting duplicate submission. Refresh the page to get these messages.
- **Normal shutdown:** SIGTERM/SIGINT stop new mutations and collector callbacks, release waiting hooks to the original app (never auto-approve), flush debounced state and report data through the existing serialized write queues, and wait for them to drain. A failed or timed-out save exits unsuccessfully instead of claiming success. The default drain deadline is three seconds.
- **Usage refresh:** scheduled and manual Claude usage checks share one in-flight attempt, with a 60-second minimum between attempt starts, including failures. Early requests receive an explicit retry delay. Disabled collection remains disabled. Failure does not invent a new cache timestamp. Credential reading and the inactive renewal implementation are unchanged.

## Independent review corrections

1. A receipt now has an explicit wall-clock deadline. Delayed timers after Mac sleep cannot accept an expired receipt. The regression failed against Claude's initial implementation (200 instead of 410) and passes after correction.
2. Unconfirmed and legacy responses no longer return `ok: true` to old dashboards. Updated-page tests also assert that their notice never says “Approved.”
3. Asynchronous Codex/Chat/Grok callbacks are ignored during shutdown, and `/state` no longer prunes sessions during the final flush.
4. The refresh gate uses an explicit unset timestamp so a clock starting at zero still enforces cooldown.
5. Shutdown and receipt deadlines are bounded even when environment overrides are negative or excessive.

## Validation performed by Codex

- **27 test files passed**, using the local Node runtime. Complete suite results: `/private/tmp/monitor-backend-completion-final-results.json`.
- Additional final run of `test-backend-review-edges.js` passed after adding slow-body shutdown checks for `/event`, `/ask`, `/usage`, `/ack`, `/decide` and `/dismiss`.
- `node --check server.js`, `node --check approve.js`, and `git diff --check` passed.
- Synthetic end-to-end test runs the actual `approve.js` against an isolated server, checks receipt confirmation and stdout output, and executes no approved command.
- Integration coverage includes missing/wrong/late/replayed receipts, concurrent approvals, newer events, legacy hooks, disconnected hooks, graceful drain inside debounce windows, queued writes, failed final save, held hook release, Codex child termination, concurrent refresh, scheduled/manual sharing, cooldown, disabled refresh and unchanged cache age.
- Independent source-level tests cover delayed timers, late collector callbacks, a zero-based clock and requests interrupted while their bodies are still being read.
- Existing grouping, single-click approval, unknown-state handling, daily 06:00 review reset, Cursor usage fallback, Grok handling and privacy tests remain passing.

Tests use temporary HOME/data directories and non-production ports; collectors and notifications are disabled or replaced with synthetic stubs. No real approval was granted or denied. No real account/Keychain mutation was tested or performed. No layout, theme or icon changes were made; only approval/refresh messaging changed in the page.

## Limits

A receipt confirms that the hook received and output a decision, **not** that the agent executed the tool. A process dying between output and acknowledgement remains ambiguous, as it must. Graceful saving does not guarantee recovery after SIGKILL, a crash or power loss; no fsync-based crash durability was added. Short-lived helper processes are not all awaited at shutdown. Claude ordinary Chat/Cowork tracking and credential renewal are not repaired or activated by this change.

## Deployment and rollback

The reviewed branch is merged into this local checkout's `main`; there is no GitHub PR or remote merge. Before applying to `~/agent-monitor`, the deployment script checks original source hashes and makes a complete local backup. It copies only reviewed source/test/document changes. It restarts the existing LaunchAgent only after two fresh zero-pending-approval checks and then verifies service health. The actual backup path, merge commit, file hashes and restart result are recorded beside the checkout in `backend-completion-deployment-20261005.json`.

For rollback, restore only the changed source files from that backup; do not overwrite live runtime state or credentials. Restart the existing service only after verifying there are no pending approvals.
