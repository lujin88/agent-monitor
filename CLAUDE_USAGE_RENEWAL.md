# Claude usage renewal

> Deployment status: automatic renewal is NOT enabled. The original read-only
> collector was restored on October 5 because native Keychain access requires user
> authorization that has not been completed. The candidate is retained as
> `claude-usage-renewal.js`. The Monitor service was not restarted.

The usage reader previously rejected expired Claude Code access tokens without
renewing them. Desktop Chat login is separate; opening the desktop app does not
necessarily renew the Code credential used by this collector.

The revised collector renews near expiry (within 60 seconds), or retries once after
an HTTP 401. It uses the existing refresh token, client ID and granted scopes.
Requests go only to the fixed Anthropic usage endpoint and the token endpoint used
by the installed Claude Code client. Redirects are not followed. No model request,
conversation, or approval is created.

Renewal uses both Claude Code refresh-lock paths. An occupied lock is left alone;
the next normal poll retries. After acquiring the lock, the collector rereads the
credential and adopts newer login data instead of overwriting it. Credentials are
not logged or written to a plaintext file. Cache timestamps advance only when
the usage API returns valid windows.

## Keychain writer

`claude-keychain.swift` calls macOS Security APIs directly. The request travels over
stdin, never process arguments or environment variables. The helper only updates
the existing `Claude Code-credentials` entry for the current user. It compares the
current value's SHA-256 before writing and verifies the full value after writing.
Other fields in the credential object are preserved.

Build on this Mac:

```sh
xcrun swiftc -O claude-keychain.swift -o claude-keychain
./claude-keychain --self-test
node test-claude-usage.js
node test-claude-renewal.js
```

The helper's self-test writes, verifies, and removes a unique temporary Keychain
entry containing a 16 KB dummy value. It does not read the Claude entry.

Do not use `security -i` for writing renewed credentials. During the October 5
investigation, its input-line limit truncated a refreshed credential. That attempt
was not deployed to the running Monitor, but it damaged the existing login entry;
a fresh Claude Code login is required to restore it. The replacement helper avoids
that line-length limit.

## Deployment and verification

Back up the existing module, then deploy `claude-usage.js`, `claude-keychain`, and
its Swift source together. Do not replace `server.js`. Before restarting the existing
Monitor service, verify that `/state` has zero pending approvals. Never start a
second production instance. A fresh usage timestamp and `usageStatus.claude: ok`
confirm that usage was received; an authentication-status command alone does not.

The existing service polls every five minutes. This integration does not track
ordinary Claude Chat or Cowork task progress. Those sources remain untracked.

If the login is revoked or the refresh token expires, use
`claude auth login --claudeai` with the intended Claude account. Never share the
resulting credentials or authorization code in chat.
