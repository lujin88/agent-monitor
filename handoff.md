# 交接摘要
更新日期：2026-11-19

## 项目
本地看板，监控 Claude Code、Cursor、Grok、Codex 的状态和用量。服务跑在 Mac mini 上，MacBook 和 iPad 用浏览器看。

## 已确认的决定
- Claude 和 Codex 不等 Lu 批准就继续跑，看板主要用来看状态，不是用来批准：因为 Lu 说反正都会批准（Lu）。
- Grok Bot 在等输入时不进 "Needs your action"，只在 Live activity 显示（Lu，PR #13）。
- 服务要带 `MONITOR_HOST=0.0.0.0`，否则只有本机能打开看板（LaunchAgent `com.lu.agent-monitor`）。
- 旧的窗口观察（ChatObserver）默认停用；Claude Chat 和 Cowork 一律显示 Untracked（README）。
- 设计 PR 由 Lu 合并；代码 PR 可以直接合并。

## 最近做完
- Cursor 3.x 把登录凭证加密存储（`cursor-safe-storage:v1:`），已改为用钥匙串 "Cursor Safe Storage" 解密后再用（PR #14，已合并、已部署到 Mac mini）。

## 待确认问题
- PR #11、#12、#13 等 Lu 合并（标题对齐、design system 重写、Grok 等待卡片）。
- PR #5–#9（agent 开的）和 #12 会冲突：#12 合并后要基于新 main 重做，不要直接合。

## 下一步
- Mac mini 上重启服务后，确认 Cursor 和 Grok 用量恢复、MacBook/iPad 能打开看板。
