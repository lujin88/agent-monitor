# Backend review and independent verification — 2026-10-05

## Result
Claude Code reviewed and edited a sanitized, local source snapshot. Codex independently reviewed the changes and tested them before merging. No source was pushed to GitHub. This directory contains no production credentials or runtime data.

- Original snapshot: `f0e420c`.
- Claude changes: `6d2579f`; detailed findings: `BACKEND_CLAUDE_REVIEW.md`.
- Final verification: all **25 test files passed**, all JavaScript syntax checks passed, and `git diff --check` passed.
- Original baseline: 22 of 23 tests passed. The failure was the inactive renewal test importing the active read-only module.

## Accepted improvements
- Reject malformed/non-object HTTP bodies, unsafe argument types and oversized payloads without crashing the service; preserve split UTF-8 characters.
- Guard expired and disconnected approvals, including delayed timers after sleep; an undelivered decision does not mark the task running.
- Serialize state writes and replace files atomically; preserve malformed top-level JSON files for diagnosis. Save state with mode 0600 and omit approval commands from persisted state.
- Handle Codex subprocess stdin errors, non-object output and unbounded partial lines.
- Bound Grok roster requests and settle interrupted responses so activity tracking can reconnect.
- Keep malformed approval-hook input from becoming a misleading approval card.
- Fix the inactive renewal test's import and isolate test homes/notifications.

## Independent review corrections
Claude's tests passed, but additional fault injection found two gaps:
1. Failed state writes started the next write before asynchronous cleanup finished. Cleanup could delete the next write's temporary file. The writer now waits for cleanup and reports only the filename and OS error code.
2. Grok's socket timeout did not cover DNS/TLS setup or indefinitely trickling responses. A whole-request eight-second deadline now settles the roster and destroys the request.

`test-backend-io-failures.js` failed against Claude's initial changes and passes after these corrections. `test-backend-hardening.js` fails against the original baseline on late approval handling. A separate HTTP check reproduced the original crash on a JSON `null` event; the final version rejects the request and remains alive.

## Boundaries and remaining limitations
- All test approvals are synthetic, on isolated ports. No real request was approved or denied.
- Frontend, active Claude read-only usage collector, inactive renewal candidate and native Keychain helper are unchanged. Automatic credential renewal remains disabled.
- Claude Chat/Cowork tracking and notification delivery are not newly established by these backend tests.
- Approval delivery means writing to the connected local hook socket; the current protocol has no separate application acknowledgement.
- Atomic file replacement is not a guarantee against power loss: there is no fsync or shutdown flush, and up to 200–500 ms of debounced updates can be lost on abrupt termination.
- Authenticated clients can still create many task/source records, and manual Claude refresh has no minimum-interval rate limit. These policy/protocol changes were deferred.
- Live deployment must preserve credentials, runtime data and app bundles; restart only after a fresh zero-pending-approval check. See the separate deployment receipt for the actual result.
