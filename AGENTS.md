# Agent Monitor：AI 协作规则

Mac 上的本地小服务加一个看板：Claude Code、Cursor、Grok、Codex 通过 hooks 上报状态，iPad 上看。我是 Lu，产品设计师，不读代码，做最终判断。

## 先读
- `handoff.md`：做到哪、已定的决定、下一步。先读它，不要先翻代码。
- `README.md` 有 22 KB：只读用得上的那一节，不要整份读。

## 不要主动读
- 根目录里名字带日期、REVIEW、AUDIT、CHANGES、COMPLETION 的 `.md` 是历史记录，我点名才读。
- `_archive/`、`_backup-*/`、`screenshots/`、`*.log`。

## 不要碰
- `token.txt`：能批准命令的密钥。不读出来、不打印、不提交。
- `state.json`、`reports.json`、`usage.json`、`notification-reader-status.json`：服务运行时自己写的数据，不手改。
- `~/.claude/settings.json` 里的 hooks 由 `setup-claude.js` 管，要改先问我。

## 结构
- `server.js`：服务，默认端口 7777。`index.html`：看板。
- `notify.js`、`approve.js`：hooks 上报和批准。
- `*-watch.js`、`*-usage.js`：各个来源的状态和用量。
- `test-*.js`：测试，一次跑一个：`node test-<名字>.js`。

## 工作方式
- 改代码前列出要改什么、动哪些文件，我确认后再动手；不顺手改别的地方。
- 命令输出长就用 `tail -20` 或 `grep`，不要整份打印日志或文件。
- 向我汇报用结果和截图，不贴代码。
- 没有依据的不要补全，写成“待确认”。

## 每做完一段
更新 `handoff.md`（保持在 40 行以内，旧内容删掉或合并，不记 git 状态）。

## 收工
我说“收工”“今天到这”或 “wrap up” 时，按顺序做，不用我再提醒：
1. 更新 `handoff.md`。
2. 找出这次我纠正过你、或我明说“以后都这样”的事。规则里已经有的跳过。同一件事被纠正过两次、或我明说过才提议，每条写清：原话、写进哪个文件哪一节。分两组给我：“建议直接写”和“你来定”。我同意才写。没有就说“这次没有新的”，不要硬凑。新增一条时，看有没有旧的可以合并或删掉，本文件保持在 60 行以内。
3. 用一两句话说这次哪里多花了上下文（例如整份读了大文件、贴了长输出、重复读同一个文件），下次怎么避免。
