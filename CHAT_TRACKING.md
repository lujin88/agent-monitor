> **2026-10-01：已默认停用。** 这个观察器依赖聊天窗口在屏幕上可见、并读取界面控件，不能可靠反映后台 Chat/Cowork 任务。服务现在只有在 `CHAT_WATCH=on` 时才运行它，看板也不把它的结果计入任务。Claude Chat / Cowork 在看板上显示为 Untracked。以下为历史说明。

# Ordinary chat tracking

The read-only Chat Observer complements CLI hooks. It observes explicit accessibility controls in Claude and Grok desktop windows and Claude, ChatGPT and Grok browser chats. It does not inspect credentials, copy message bodies, send messages, click controls or grant approvals.

## Enable

1. Unlock the Mac.
2. Open Agent Monitor and click the radar icon in the header.
3. Choose **Enable on this Mac**, then enable **ChatObserver** under System Settings → Privacy & Security → Accessibility.
4. Open a supported ordinary chat and start a response. The observer checks roughly every four seconds. The dashboard should show an individual **Chat** card.

An explicit responding/stop-generation control means **Running**. Two complete observations of the ready-to-send state confirm completion, provided the observer can identify the chat. Existing idle chats are not imported as completed tasks. Permission controls produce an action reminder; ordinary-chat permissions must be handled in the original app.

Locked screens, inaccessible windows, hidden tabs and ambiguous chat identity produce **Status unknown** for previously observed work. Silence is never treated as completion. The radar panel reports permission and lock status. This is not a cloud-wide history or background-tab API; only UI states actually exposed by the app are observed.

The installed ChatGPT/Codex hybrid app's coding tasks retain their existing hook/log integration. Ordinary browser ChatGPT chats are recognized by their chatgpt.com / chat.openai.com web area; unsupported native views are not guessed to be ChatGPT conversations.

Implementation: ChatObserver.swift → ChatObserver.app (launched through macOS LaunchServices so the granted app identity is used) → a private, temporary metadata snapshot → chat-watch.js → server state → dashboard. Temporary snapshots are deleted after each scan. No transcript data is sent to external services. Set CHAT_WATCH=off on the monitor service to disable this observer.

Validation: reducer tests cover lifecycle, parallel chats, partial scans, ambiguous identity, lock and missing permission. App-launch tests verify the authorized app launch path, private snapshot permissions, cleanup and error handling. After rebuilding the native app, macOS may require ChatObserver to be removed and added again in Accessibility because its local code signature changes. Live validation must confirm both a responding control and its corresponding Monitor state.
