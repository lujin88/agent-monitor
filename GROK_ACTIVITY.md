# Grok Bot background activity

Reads the installed app's `GrokBotService/WatchGrokBotTranscripts` state stream at
`https://api2.cursor.sh`, with empty transcript cursors, no unlisted agents, and zero
inline body bytes. Only live agent state and turn-failure signals are processed.
Transcript rows, client message previews, tool arguments, and bodies are discarded;
none are saved or logged. Agent names come from the read-only ListGrokBotAgents call.
Credentials use the same verified account match as Grok usage. No refresh tokens,
messages, approval decisions, app modifications, or Accessibility permission are used.

Mapping:
- Running, composing, retrying, or running subagents -> Running.
- Awaiting user input -> Needs your action; handle inside Grok Bot, not Dashboard approval.
- Observed active -> idle -> Ended. This proves activity ended, not output success.
- Idle on first connection creates no completed task.
- Disconnect, expired state, missing snapshot row -> Status unknown, never completion.
- Turn failure -> Status unknown, never successful completion.

Reconnects automatically with backoff. Idle connection timeout is 45 seconds;
per-task freshness uses server staleAfterMs. Renew connection every four minutes
to reread login state. Set GROK_WATCH=off to disable. No app window needs to stay open.
Old window-observer Grok records are hidden when this integration is present.

Oct 4 live check: HTTP 200 snapshot, then continuous running reports for the task
started by the user (12:34:49–12:36:00 UTC). Waiting and completion mapping tested
with synthetic frames; real transitions should be checked separately if not observed.

Regression tests: test-grok-watch.js, test-server-state.js, test-approval-state.js,
test-coverage-state.js, test-codex-recovery.js, test-daily-review.js,
test-connections.js, test-source-coverage.js.
