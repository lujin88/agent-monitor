# Backend completion (Claude) — 2026-10-05

Branch `claude/backend-completion`, on top of deployed baseline `fc4fd1a` (nothing reverted).
This is a sanitized source-only copy. I did not access the live monitor directory, credentials, Keychain,
the notification database or port 7777. Nothing was approved, denied, sent, committed, restarted or deployed.

**Tests: NOT RUN.** I could only read and edit files. Every statement below about behavior describes the code
as written and the tests as designed. None of it has been executed yet. No end-to-end connection to a real
Claude Code or Codex session has been established or claimed.

## 1. Approval receipt acknowledgement

### Protocol
1. The hook (`approve.js`) sends `POST /ask` with `ack: 1`, which means "I can confirm receipt".
2. The server generates a 128-bit random secret for that request (`crypto.randomBytes(16)`). It is stored only
   in the in-memory `pending[aid]` / `receipts[aid]` entries. It is not part of the `approval` object, so it never
   appears in `GET /state`, `state.json` or logs.
3. On Approve or Deny, the held `/ask` response is `{decision, aid, receipt}`. That reply goes only to the
   requesting hook's own connection. "Handle in app", expiry, disconnect and shutdown send `{decision:"none"}`
   with no secret.
4. The hook validates the response: HTTP 200, ≤16 KB, a JSON object, decision `allow`/`deny`, and hex
   `aid`/`receipt` formats. It writes the hook output to stdout and **waits for the stdout write callback**
   (flush). Only then does it send `POST /ack {aid, receipt, decision}` with a 1.5 s timeout, and it exits exactly
   once. Nothing is acknowledged if the stdout write fails.
5. `/ack` requires the access key **and** a loopback address. Results:
   - 200: confirmed.
   - 403: wrong secret or a different decision. The receipt stays open for the real hook, and the comparison is
     constant-time.
   - 410: unknown, duplicate or expired receipt.
   - 503: the server is shutting down.
6. `POST /decide` now waits, bounded by `APPROVAL_ACK_MS` (default 4 s, capped at 7 s, below the Dashboard's 8 s
   abort), and returns `{ok:true, delivery}`. `delivery` is one of:
   - `confirmed`: the hook acknowledged receipt and flushed the output.
   - `unconfirmed`: the decision was written to the hook socket, but no valid receipt arrived in time (or the
     server shut down).
   - `unsupported`: a legacy hook (no `ack: 1`). The decision was written, and receipt cannot be confirmed.
   - `released`: "Handle in app" reached the hook; the agent app's own prompt takes over.

   A decision that never reached a connected hook still returns 410, as before.

### Task-state semantics
- After an Approve/Deny is written, the session becomes `unobserved` ("status unknown") with
  `delivery: {aid, decision, state}`. A message says the decision was sent and receipt is pending, unconfirmed or
  unsupported. This is deliberately different from "Dashboard approval ended" (`needs_action`, not approved): the
  hook may already have output the decision.
- A session moves to `running` **only** on a matching receipt. It also requires that the session's `delivery`
  marker still names this `aid` with state `awaiting` and that no other request is queued for the session. Any newer
  event (`done`, `running`, `resume`, a new `/ask`) replaces the record and its marker, so a delayed receipt can't
  overwrite it.
- Exactly one human decision per request: `decide` deletes `pending[aid]` before writing. A second `/decide`
  returns 410. The receipt only confirms; it never applies or changes a decision.
- Concurrent approvals each have their own `aid` and secret. One request's secret cannot confirm another.
- A stored `awaiting` state found at startup (after a crash) is rewritten as `unconfirmed`.
- **Receipt ≠ execution.** The receipt means only that the hook received the decision and flushed it to its
  stdout. It does not prove that the agent parsed the decision or ran the tool, and nothing in the UI says so.

### Dashboard (`index.html`, minimal edits)
- Only `delivery === "confirmed"` gives "Approved/Denied. The hook confirmed it received your decision."
- Every other success (`unconfirmed`, `unsupported`, or a missing field from an older server) shows a warning
  notice: "… sent, but receipt was not confirmed. Check the agent app; do not answer again." The dialog closes
  either way, so the same approval cannot be sent twice.
- The running/unknown row shows "Decision sent · …" instead of "No recent activity" for these sessions.
- Single-click submission, duplicate prevention, expiry and close/reopen handling are unchanged.

## 2. Graceful shutdown

On SIGTERM or SIGINT (once):
1. Set `closing`. Every POST, including `/ask`, `/decide`, `/ack`, `/dismiss`, `/usage`, `/event` and the refresh
   endpoint, returns 503. This is checked both before and after reading the body. `GET /state` keeps working
   until exit.
2. Clear all background intervals and timeouts, stop the Grok watcher, stop and kill the running Codex
   `app-server` poll child, and call `server.close()` / `closeIdleConnections()`.
3. Every held `/ask` gets `{decision:"none"}`: released to the agent app, never approved. Its session keeps the
   command-free approval marker, so the next start shows the existing "Dashboard restarted. Confirm this request
   in the agent app." Receipts still being waited for are settled as `unconfirmed`.
4. If state or reports are dirty, the latest snapshot is queued **through the same per-file `writeJson` queue**.
   A newer queued snapshot replaces an older queued one, and there is no separate synchronous writer. Commands are
   still stripped, and files are still written with mode 0600 and atomic rename. Pollers that finish late cannot
   write usage (`setUsage` checks `closing`).
5. Wait for all write queues to drain (`drainWrites`) and for the released hook replies to flush. Exit 0 only if
   the latest write of every file succeeded. Otherwise, log the file name and OS code only, and exit 1. A hard
   deadline (`SHUTDOWN_TIMEOUT_MS`, default 3 s) forces exit 1 with a message.

No fsync was added. Shutdown protects against losing the debounce window on a normal stop. It does not protect
against SIGKILL, crashes or power loss.

## 3. Claude usage refresh gate

`createRefreshGate` in `server.js` wraps the unchanged `createClaudePoller`. Scheduled polls (2 s after start,
then every 5 min) and `POST /usage/claude/refresh` both go through it:
- **One shared in-flight attempt.** Concurrent callers get the same promise, and the result comes from that
  attempt only: the status reported by `onStatus` during this attempt, or `error` if none was reported. It is never
  an older cached `ok`.
- **Minimum 60 s between attempt starts**, including failed attempts. Inside the interval the result is
  `too_soon` with `retryAfterMs`, and there is no credential or network work.
- HTTP responses:
  - 200 `{ok, status, attemptedAt}`
  - 429 `{status:"too_soon", retryAfterSec, lastAttemptAt}` with a `Retry-After` header
  - 409 `{status:"disabled"}` when `CLAUDE_USAGE=off`, without touching the gate
  - 503 while shutting down
- Cached usage and its `updatedAt` are only replaced on success, as before.
- UI messages: "Claude usage was checked recently. Try again in Ns." and "Claude usage is turned off on this Mac."
- `claude-usage.js`, `claude-usage-renewal.js` and `claude-keychain.swift` are unchanged. Renewal stays inactive.

## Changed files
- `server.js`:
  - receipts (`decide` return values, `settleReceipt`, `acknowledge`, `receiptOutcome`, `/ack`, `/ask ack:1`)
  - writer `ok`/`idle` + `drainWrites`
  - `writeState`/`save` dirty tracking
  - shutdown and background-timer registry
  - Codex child stop
  - refresh gate
- `approve.js`: `ack: 1`, response validation (status, size, shape), once-only callbacks, flush-before-receipt,
  single exit, stdout EPIPE guard.
- `index.html`: decision messages, notice warning flag, unknown-row copy, refresh 429/409 messages.
- Tests updated:
  - `test-backend-hardening.js`: decision harness for the new contract; it adds the legacy, receipt, wrong-secret,
    wrong-decision, duplicate and handle-in-app cases, and no safety assertion was removed.
  - `test-approval-click.js`: confirmed vs unconfirmed wording.
  - `test-backend-io-failures.js`: drain tests.
  - `test-approval-state.js`, `test-codex-recovery.js`, `test-server-state.js`, `test-coverage-state.js`: these now
    wait for the server to exit after SIGTERM before deleting temp directories, because the server now saves on
    SIGTERM.
- New test file: `test-backend-completion.js`. It uses the existing module list plus `approve.js`; no backend
  module was added.

## Tests added (NOT RUN)
- `test-backend-completion.js`:
  - **approve.js harness:**
    - prints once despite duplicate callbacks
    - no `/ack` before the stdout flush callback
    - correct `/ack` body and key
    - exactly one exit
    - non-200, oversized, malformed, non-object, unknown decision and unreachable server all print nothing
    - legacy or malformed receipt: prints, no ack
    - stdout write error: no ack
  - **Isolated server, receipts:**
    - the real `approve.js` end to end with a synthetic payload: `confirmed`, output `allow`, status `running`
    - secret absent from `/state`, `state.json` and stderr
    - `/ack` returns 401 with a wrong key, and 403 for a wrong secret or a different decision; the real receipt
      still works after a 403
    - duplicate receipt: 410
    - missing receipt gives `unconfirmed` and status stays unknown; a late receipt gets 410 and no change; a second
      decision gets 410
    - a newer `done` event is kept despite a later receipt
    - legacy hook gives `unsupported`
    - "Handle in app" gives `released` + `none`
    - hook disconnected before the decision: 410
    - concurrent approvals keep separate secrets and outcomes, and an earlier receipt doesn't overwrite the later
      decision
  - **Shutdown:**
    - SIGTERM inside the debounce window after 30 queued saves: all saved, reports flushed, mode 0600, no temp
      files, exit 0 within the bound
    - held approval: the hook gets `none` and its command is not persisted; a pending receipt gives `unconfirmed`
      both to the Dashboard and on disk; the approval marker is kept for the restart message
    - failed save (`state.json` is a directory): exit 1, error message, no temp file
    - a synthetic `CODEX_BIN` shell stand-in (`sleep`) is killed; no abandoned child
  - **Refresh:**
    - extracted-gate tests with a fake clock: shared promise, exact retry delay, no stale `ok`, failures count
    - isolated server with a stub `claude-usage.js` written into the temp copy: 3 concurrent calls share 1
      attempt, the scheduled poll is suppressed, 429 + `Retry-After` with no extra stub call, cached timestamp
      unchanged, `CLAUDE_USAGE=off` gives 409 and zero calls
- `test-backend-io-failures.js`: an in-progress write plus a queued older state plus the final snapshot. Only the
  final snapshot is written after the in-progress one, the older one is skipped, and the drain waits for it. A
  failed final write is reported by file name.

All tests use random ports in 18000–21900 (never 7777), temporary HOME and data directories,
`MONITOR_NOTIFICATIONS=off` and every collector off, except the stubbed Claude poller and the fake Codex binary
where those are the subject. They use synthetic commands that are never executed.

Suggested run (parent): `for f in test-*.js; do node "$f" || echo "FAIL $f"; done`. `test-approval-click.js` needs
jsdom. Also run `node --check server.js approve.js`.

## Compatibility
- Legacy hooks (no `ack`) work as before on the hook side and still get `{decision}`. The Dashboard now honestly
  reports them as "receipt not confirmed", and the task shows "status unknown" instead of "running" until a later
  hook event.
- `/decide` keeps 200/400/410 and its `ok` field; it adds `delivery` and can take up to `APPROVAL_ACK_MS` longer.
- Behavior on a pending approval at restart is unchanged ("Dashboard restarted …"). A normal start is unchanged,
  and SIGTERM now exits after saving instead of immediately.
- Daily 06:00 review window, grouped tasks, unknown state, Cursor fallback, Grok feed, notification privacy and
  disabled window observation were not touched.

## Remaining limits and risks for parent review
- **Not run.** Timing-sensitive integration steps can be flaky on a loaded machine and may need larger pauses:
  - the 1.5 s receipt window in the late-receipt case
  - SIGTERM inside the 200 ms debounce
  - the 2 s scheduled Claude poll racing the first manual refresh
- The receipt proves hook receipt and stdout flush only, not agent parsing or execution. If the hook dies after the
  flush but before `/ack`, the result is `unconfirmed`, even though the agent may have the decision.
- Receipt-capable `approve.js` adds up to 1.5 s before the hook exits when the server is slow or unreachable.
- The Dashboard's `/decide` request now stays open up to ~4 s. If the network drops during that time, the existing
  "No confirmation received … check the agent app" path applies. The decision itself was already sent once and is
  never resent automatically.
- Shutdown does not wait for short-lived `execFile` children (the Cursor `sqlite3` read, `osascript`
  notifications, chat observer `open`). They have their own timeouts, but these are enforced by the parent, so one
  could outlive a stopped server for a few seconds.
- No fsync: a rename that has completed is not guaranteed to survive power loss.
- `/state` does not expose the refresh gate's next-allowed time. Only the 429 response carries it.
- The 503 for mutations during shutdown is implemented but not tested black-box, because shutdown is normally too
  fast to hit.
- The parent must still confirm there are zero pending approvals before restarting the live service.
