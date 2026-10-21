# Backend review — Claude, 2026-10-05

Scope: `server.js` and the backend modules it loads (`codex-watch.js`, `grok-watch.js`, `grok-usage.js`, `cursor-usage.js`, `claude-usage.js`, `chat-watch.js`), the hook scripts (`approve.js`, `notify.js`, `statusline.js`), and the backend tests. Baseline: commit `f0e420c`. Line numbers below refer to that baseline.

Nothing was run. I had no shell, so **every test listed here is NOT RUN**, including the new one. Nothing was committed or deployed. I did not access port 7777, credentials, the Keychain or live data.

## Findings

### F1. A `null` body or a prototype-named key crashes the whole server (High)
`server.js:193-200` `readJson` returns whatever `JSON.parse` produces. Handlers then destructure or dereference it inside an `async` request handler that has no catch (`server.js:350`). On Node ≥ 15 an unhandled rejection terminates the process, which also drops every held approval.
- `POST /decide` with body `null` → `const { aid, decision } = null` throws TypeError. Any client holding the key can do this, including from the iPad over the LAN.
- `POST /decide {"aid":"constructor","decision":"allow"}` (or `toString`, `hasOwnProperty`, `__proto__`): `pending` is a plain `{}` (`server.js:36`), so `pending['constructor']` is `Object`. `resolvePending` then sets `Object.delivered = false` and reads `p.res.writableEnded` of `undefined`, which throws and crashes the process. `__proto__` also writes `delivered` onto `Object.prototype`.
- `POST /event` / `/ask` with `null` → `delete e.progress` / `e.source` throws (local only).
- `POST /usage {"windows":[null]}` → `w.resetsAt` of null throws in `setUsage` (`server.js:108`).

### F2. Malformed bodies are accepted as `{}` and coerced (Medium)
- Invalid JSON resolves to `{}` (`server.js:197`). For `/ask` this created a live approval card with source `unknown`, session `default` and an empty command.
- `/ask` used `String(e.command)`, so `{"command":{...}}` was shown as `[object Object]`. The user would have approved something they could not see.
- `/dismiss {"allDone":"false"}` is truthy and deleted every completed task (`server.js:445`).
- `/usage` accepted any `source` (for example `__proto__`) as a key of a plain object.
- `setUsage` used `Number(w.usedPercent)`, so `null` became **0 % used** rather than "no data".

### F3. UTF-8 corruption in request bodies (Medium)
`readJson` does `b += c` on raw Buffer chunks (`server.js:196`). A multi-byte character split across TCP chunks became U+FFFD. Titles and messages are often Chinese, so this happens in practice. An oversized body called `req.destroy()` and left the promise unresolved forever.

### F4. Approval lifecycle gaps (High: safety contract)
1. **Undelivered approve marks the task running.** `decide()` (`server.js:280-297`) returned `false` (410) correctly, but still set the session to `running` with an empty message, as if it had been approved.
2. **Late approvals.** `/decide` checked only that `pending[aid]` existed, not `approval.expiresAt`. Timers can fire late after Mac sleep or a busy event loop. In that window an expired request could still receive `allow`.
3. **Disconnect before registration.** `/ask` registers `res.on('close')` only after the body has been read (`server.js:431`). If the hook died during that time, `close` had already fired. The card then stayed approvable until the 60 s timer, although `decide` would return 410.
4. `resolvePending` did not check `res.socket` and had no guard around `writeHead`/`end`.

### F5. State file durability (High: data loss)
- `save()`, `setUsage()` and `noteReport()` use plain `fs.writeFile` (`server.js:57,117,185`). A crash or kill during the write leaves a truncated file. On the next start, `JSON.parse` fails, the `catch (_) {}` silently starts empty, and the next save overwrites the evidence.
- Overlapping writes to the same file are not serialized. `setUsage` is called by four pollers and the `/usage` hook with no debounce, so two concurrent `fs.writeFile` calls to one path can interleave.
- A structurally wrong file crashes startup or loses data:
  - `state.json` = `null` → `Object.values(null)` throws at `server.js:34`, which means a crash loop.
  - An entry that is `null` → `s.approval` throws.
  - `state.json` = `[]` → sessions are stored on an array and serialize back as `[]`, losing them silently.
  - `usage.json` = `null` → later `usage[source] =` throws inside a poller callback.
  - A session without a string `id` crashes `grok-watch` seeding (`s.id.replace`).
- **Privacy:** `state.json` persisted the full approval `command`, which can contain secrets (curl headers, tokens), even though approvals are discarded on restart. Files were created with the default umask (typically 0644).

### F6. Codex poller can crash the server (Medium)
`pollCodex` (`server.js:144-180`):
- No `'error'` listener on `child.stdin`. If the app-server exits early, a write raises an asynchronous EPIPE `'error'` event, and an unhandled one terminates Node.
- A JSON line `null` makes `m.id` throw inside the `'data'` handler, which is an uncaught exception.
- `buf` grows without bound if output has no newline.
- Chunks were concatenated as Buffers (same UTF-8 issue as F3).

### F7. Grok roster request can hang the watcher forever (Medium)
In `grok-watch.js:54-63` `roster()`, the >2 MB cap and the 8 s idle timeout call `req.destroy()` after the response has started. That may emit neither `end` nor `error` on the response, so the promise never settles. `connect()` then waits forever. Because `request` stays `null`, the 5 s health check (`if(!request)return;`) never reconnects, and Grok activity stays stuck at "connecting". Raw Buffer concatenation also had the UTF-8 issue.

### F8. `approve.js` could ask about a payload it never read (Medium: safety)
`approve.js:59` parsed `raw || '{}'` and ignored parse errors. The 1 s safety timer (`approve.js:94`) runs `run()` even if stdin has not finished, so a partial payload fell back to `{}`. The result was an approval card with session `default` and command `{}`. Approving it would answer the agent's real request, which the user never saw. `notify.js` crashed on a literal `null` payload (exit 1 only, but noisy).

### F9. Tests targeting the wrong module or touching the real machine (Medium)
- `test-claude-renewal.js` required `./claude-usage` (the active read-only module). That module does not export `renewCredentials`/`withRefreshLock`, so the test cannot have exercised the inactive candidate it describes.
- `test-codex-recovery.js` sends a real `/ask` without `MONITOR_NOTIFICATIONS=off`, which fires a real macOS notification via `osascript`.
- `test-codex-recovery.js` and `test-server-state.js` run without an isolated `HOME`, so the server reads the real `~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.cursor/hooks.json` (it reports status only, but the tests should not touch them).

## Changes made

**`server.js`**
- `loadJson` / `recordMap` / `writeJson` (new, ~35 lines near the top):
  - Startup only accepts plain-object files. A damaged or wrongly shaped file is renamed to `<file>.corrupt-<ms>` and logged, not silently overwritten.
  - Sessions with a non-object value or unknown status are dropped. `id` is forced to its key, and `source` falls back to the key prefix.
  - All maps (`sessions`, `usage`, `reports.sources`, `pending`) are null-prototype.
  - Writes go to `<file>.<pid>.tmp` (mode 0600) and are then `rename`d. Writes are serialized per file, and the latest pending content always wins.
- `save()` drops `approval.command` from the persisted copy and keeps `{aid, tool, expiresAt}`, so the "Dashboard restarted" message still works. The live `/state` response still includes the command.
- `readJson`:
  - Collects Buffers and decodes once (UTF-8 safe).
  - Enforces the 1 MB limit with a 413 response and `Connection: close`.
  - Returns `{ error: 400 }` for malformed JSON, `null`, arrays and primitives. An empty body is still `{}`.
  - Resolves on `close`, so it can no longer hang.
- Handlers:
  - `/event`, `/ask`, `/usage`, `/decide`, `/dismiss` return 400 for bad bodies.
  - `/decide` requires a string `aid`.
  - `/dismiss` requires a string `id` and a boolean `allDone`.
  - `/ask` requires `command`/`tool`/`description` to be strings when present.
  - `/usage` `source` must match `[A-Za-z0-9_-]{1,30}`. A missing source still means `claude`; an explicit empty source is rejected.
- `setUsage` ignores non-object windows, treats a missing/null percent as no data, and keeps at most 8 windows.
- Approval safety:
  - `decide()` releases a past-deadline request with `none` and reports 410.
  - If a decision is not delivered, the task is never set to `running`.
  - `resolvePending` also requires a live socket and guards the write.
  - `/ask` releases the request at once if the requester disconnected while its body was being read. The notification is sent only after that check.
- The request handler is now `handleRequest`, wrapped so that any thrown error becomes a 500 instead of a process crash.
- `pollCodex` has an stdin `'error'` listener, UTF-8 stdout, skips non-object lines, and caps the unterminated buffer at 1 MB.

**`grok-watch.js`**: `roster()` resolves an empty roster on response `close` (a no-op after a normal `end`) and decodes UTF-8 properly.

**`approve.js`**: if the payload is empty, malformed, partial or not an object, it exits with no output, so the normal Mac prompt is used. A non-string `tool_name` is sent as `''`.

**`notify.js`**: a non-object payload is treated as `{}`.

**Tests**
- `test-claude-renewal.js` now requires `./claude-usage-renewal` (the inactive candidate). All credential reads, saves, locks and HTTP calls in it are already injected fixtures; the lock test uses a temp dir.
- `test-claude-usage.js` gains guards: the active module exports no renewal functions, does not reference the token endpoint, refresh tokens, Keychain writer or renewal module, and `server.js` does not load the renewal module.
- `test-codex-recovery.js` and `test-server-state.js` add `MONITOR_NOTIFICATIONS=off` and a temporary `HOME`.

**Not changed:**
- `index.html` and the front-end tests. No API change was needed; the UI already sends `{id}`, `{aid, decision}` and `{}` as now required.
- `claude-usage.js`, `claude-usage-renewal.js`, `claude-keychain.swift`, credentials and permissions.

## Regression tests added

`test-backend-hardening.js` uses a random port 20300–20899, a temporary HOME and data directory, every poller, watcher and notification off, and only synthetic data. It kills its server child in `finally`. It covers:

1. Startup with a damaged `state.json` (null entry, bad status, wrong id), `usage.json` = `null` and a torn `reports.json`. It checks that the server starts, keeps the valid task and preserves the damaged files as `.corrupt-*`.
2. `null`, `[]`, string and malformed bodies on `/event`, `/ask`, `/usage`, `/decide`, `/dismiss` return 400 and create no approval. `/decide` with `aid` `constructor`/`__proto__`/`toString`/`hasOwnProperty` returns 410 and the server stays up. Non-string `aid`/`id`, `allDone:"false"`, an object `command` and bad usage sources return 400. Null usage windows are ignored, and a null percent is not stored as 0.
3. A UTF-8 character split across two body chunks survives. A body over 1 MB is refused and the server stays up.
4. A requester that disconnects mid-`/ask` leaves no approvable card.
5. The approval command is visible in `/state` but absent from `state.json`, and `state.json` has mode 0600.
6. Forty overlapping `/event` and `/usage` writes leave valid JSON whose content matches memory and no `.tmp` files.
7. A request pending at restart comes back as "Dashboard restarted…", has no approval, and its old `aid` returns 410.
8. A torn `state.json` at startup is set aside.
9. Deterministic vm checks of `decide()`: an expired request is answered `none` and returns false; an undelivered request returns false and the task stays `needs_action`; a live request returns `allow`/true/`running`; prototype keys and non-strings return false.
10. vm checks of `approve.js`: empty, `null`, `[]` and partial payloads make no request and print nothing; a valid payload posts `/ask` with the exact command.

Existing source-slicing tests (`test-attention-notifications.js`, `test-stale-status.js`, `test-daily-review.js`) still find their markers (`function applyEvent(e)` … `\nconst server =`, `function prune(` … `// Answer a held`, `function reviewWindow(`). The new helpers sit outside those slices. I did not add a new module file, because several tests copy a fixed list of files into their temp dir.

## Compatibility notes for the reviewer
- These cases used to return 200 or create state and now return 400:
  - Malformed or non-object JSON on `/ask` and `/dismiss`.
  - Non-boolean `allDone`.
  - A non-string `command`/`tool`/`description` on `/ask` (`approve.js` always sends strings; on 400 it falls back to the Mac prompt).
  - Usage `source` values outside `[A-Za-z0-9_-]{1,30}`.
- `state.json`, `usage.json` and `reports.json` are now written with mode 0600 and no longer contain approval commands.
- New sidecar files may appear: `*.<pid>.tmp` (only during a write) and `*.corrupt-<ms>`. I suggest adding `*.tmp` and `*.corrupt-*` to `.gitignore`; I didn't edit it because it is outside my allowed file set.

## Deferred (with reasons)
- **`POST /usage/claude/refresh` is not rate-limited.** The busy flag only prevents overlap, so any client holding the key can trigger a Keychain read and an Anthropic API call back to back, and risk `rate_limited`. A 30–60 s minimum interval is easy, but it changes UI feedback, so I'm flagging it rather than deciding it.
- **"Delivered" means written to the local socket, not acknowledged by `approve.js`.** If the hook is killed in the microseconds after the write, the Dashboard can say "Approved" while the agent shows its own prompt. The agent still never auto-approves, so safety holds; only the message would be wrong. Closing this fully needs an acknowledgement round-trip from the hook, which changes the protocol.
- **No flush on SIGTERM and no `fsync` before `rename`.** Up to 200–500 ms of debounced state can be lost on kill. A sync flush in a signal handler would race the existing tests' `child.kill()` + `rmSync`. Atomic rename already removes the torn-file risk.
- **Unbounded keys from local clients.** Growth in `reports.sources`, `usage` sources and `unobserved`/`needs_action` sessions (which are never pruned by design) is possible only from loopback with the key. Pruning `unobserved` would change the "Status unknown until dismissed" behavior.
- **Design-level LAN exposure.** The token travels in the URL (`?key=`) over plain HTTP and is printed to the console. The server listens on `0.0.0.0`. Unchanged; the README documents these.
- **Chinese window labels.** Codex/statusline usage labels (`'5 小时'`, `'每周'` in `server.js` `codexWindows` and `statusline.js`) are stored data that `index.html` translates and matches (`windowLabel`, `usageSelection`). Changing them needs a coordinated front-end change; the user-visible text is already English.
- **`/ask` overwrites the session record.** It drops `progress`, `stateSource` and `taskKind` of the previous record. This is pre-existing and harmless to approval safety; changing it risks the grouping contract.
- **Inactive renewal candidate risk (not activated).** `claude-usage-renewal.js` `renewCredentials` rotates the refresh token at the provider *before* saving it. If all three saves fail (`claude-usage-renewal.js:108-111`), the rotated refresh token exists only in memory and is then lost, which would sign Claude Code out. The pre-save Keychain round-trip check reduces but does not remove this. Treat this as a blocker before any activation. `claude-keychain.swift` was not reviewed for activation and nothing was built.

## Tests: NOT RUN
None of the following was executed in this session (no shell available). Please run them all:

```
node test-backend-hardening.js      # new
node test-approval-state.js
node test-coverage-state.js
node test-server-state.js           # edited env
node test-codex-recovery.js         # edited env
node test-claude-usage.js           # added guards
node test-claude-renewal.js         # now targets claude-usage-renewal.js
node test-attention-notifications.js
node test-stale-status.js
node test-daily-review.js
node test-grok-watch.js
node test-notify-aliases.js
# plus the remaining test-*.js (front-end tests need jsdom)
```

Points to watch when running:
- In the new test, the 413 assertion accepts either a 413 response or a connection reset, depending on timing.
- The UTF-8 split test relies on the two writes arriving as separate chunks. If they coalesce, the test still passes but proves less.
