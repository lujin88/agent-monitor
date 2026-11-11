# Agent Monitor

MacBook 上的 Claude Code、Cursor、Grok Build、Codex 通过 hooks 把状态发给一个本地小服务，iPad 用 Safari 打开看板。Claude Code 和 Codex 要你批准时，可以直接在 iPad 上批准或拒绝。

> 2026-10-01 更新：本 README 已按实际代码校正（单击批准、用量区位置、覆盖范围说明）。改动明细与验证记录见 `CHANGES_2026-10-01.md`。

## 覆盖范围（先读）

| 来源 | 怎么知道状态 | 看板上的含义 |
|---|---|---|
| Claude Code | hooks（`notify.js` / `approve.js`） | “Hooks configured” 只表示配置文件里有监控 hooks；“Last report …” 才是实际收到上报的证据 |
| Claude Chat（普通聊天） | 没有可靠的后台数据源 | 一律显示 **Untracked**。没有数据不等于没有任务 |
| Claude Cowork | 没有可靠的后台数据源 | 一律显示 **Untracked** |
| Claude 系统通知 | 独立的 Notification Reader（见 `NOTIFICATION_TRACKING.md`） | 只作 **Estimated**（虚线、琥珀色），不区分 Chat/Cowork，不提供批准按钮；实测尚未通过 |
| Codex / Cursor | hooks；Codex 另有本地日志补偿 | 同样区分“已配置”和“最后上报时间” |

旧的窗口观察（ChatObserver，依赖聊天窗口可见、读取界面）已默认停用，不再参与看板状态。如确需调试，可用 `CHAT_WATCH=on` 启动服务；其结果也不会计入任务列表。

## 1. 启动服务（Mac）

把整个 `agent-monitor` 文件夹放到用户目录下，然后：

```bash
cd ~/agent-monitor
node server.js
```

需要 Node 16 以上（`node -v` 检查）。终端只打印 `http://localhost:7777/`，**不打印访问密钥**（日志会留在磁盘上）。在 Mac 上第一次打开时，在地址后面加 `?key=<token.txt 里的内容>`，密钥会被记住，地址栏里的 key 随即被去掉。

**iPad 怎么打开**：默认只有这台 Mac 能打开看板。要在 iPad 上审批，先按下面「监听地址」打开局域网，然后在 Mac 上打开看板，点右上角的二维码按钮（Open on iPad or phone），再点 Show code，用 iPad 相机扫一下。iPad 和 Mac 要在同一个 Wi-Fi。二维码里带着密钥，别拍照、别分享。**只在家里或可信 Wi-Fi 下用 iPad 审批。**

**监听地址**：默认只监听本机（`127.0.0.1` 和 `::1`）。要让同一个 Wi-Fi 里的 iPad 连上，设 `MONITOR_HOST=0.0.0.0`。用 LaunchAgent 跑的话，在 plist 里加：

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>MONITOR_HOST</key>
  <string>0.0.0.0</string>
</dict>
```

（plist 里已经有 `EnvironmentVariables` 的话，只在里面加 `MONITOR_HOST` 这一对。）改完要重新加载，光 `launchctl kickstart -k` 不会重新读 plist：

```sh
launchctl bootout gui/$(id -u)/<你的 LaunchAgent label>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<你的 LaunchAgent label>.plist
```

不管怎么设，hook 上报（`/event`、`/ask`、`/ack`、`/usage`）和 `/chat-tracking/setup` 都只接受本机请求；带 `X-Forwarded-For` / `Forwarded` / `Tailscale-*` 头的请求不算本机。看板只接受用 IP、`localhost` 或 `*.local` 访问（防 DNS rebinding），也不发任何 CORS 头。

密钥也保存在 `~/agent-monitor/token.txt`。因为它能批准命令，不要发给别人，也不要截图外传。

## 2. 接入 Claude Code

**最省事的办法：运行一条命令，自动配好下面所有内容（含用量百分比）。** 它会先备份 `~/.claude/settings.json`，保留你已有的设置，不会覆盖你自己的状态栏，重复运行也没有副作用：

```bash
node ~/agent-monitor/setup-claude.js
```

然后完全退出并重新打开 Claude Code，发一条消息、等它回复完，看板上的 Claude 用量条就会出现。要求：Claude Code 是用 Pro/Max 订阅账号登录的，不是 API key。下面是它写进去的内容，想手动配也可以：

编辑 `~/.claude/settings.json`，加入（已有 `hooks` 就合并进去）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node ~/agent-monitor/notify.js claude running" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node ~/agent-monitor/approve.js claude", "timeout": 330 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node ~/agent-monitor/notify.js claude needs_action" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node ~/agent-monitor/notify.js claude resume" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node ~/agent-monitor/notify.js claude done" }] }
    ]
  }
}
```

- 你提交任务：卡片进入「运行中」，标题是你发的那句话
- Claude 要批准：红色卡片，显示要运行的命令，可以在 iPad 上批准（见第 6 节）
- Claude 在问你问题或等你输入：红色卡片，需要回到 Mac 上回答
- 批准后继续跑：自动回到「运行中」
- 做完：进入「已完成」

改完设置后，新开的 Claude Code 会话才会生效。

## 3. 接入 Cursor

创建 `~/.cursor/hooks.json`：

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "node /Users/你的用户名/agent-monitor/notify.js cursor running" }],
    "stop": [{ "command": "node /Users/你的用户名/agent-monitor/notify.js cursor done" }]
  }
}
```

Cursor 的 hooks 格式随版本会变，不生效就对照你当前版本的官方文档。当前 Cursor 会自动重载 hooks 配置；配置只上报之后的新活动，不导入旧任务。Cursor 只能显示「运行中」和「已完成」，也不支持在 iPad 上批准。

## 4. 接入 Grok（Grok Build 命令行版）

适用于终端里运行 `grok` 命令的 Grok Build。创建 `~/.grok/hooks/agent-monitor.json`，路径写绝对路径：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js grok running" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js grok needs_action" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js grok done" }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js grok done" }] }
    ]
  }
}
```

- 在 Grok 里输入 `/hooks` 可以确认 hooks 是否已加载。
- Grok 也会读取 `~/.claude` 和 `~/.cursor` 里的 hooks 文件。`notify.js` 按事件内容自动识别，所以卡片会标成 Grok，不会串到 Claude 那一栏。
- Grok 不支持在 iPad 上批准：我在官方文档里没有确认到它有 `PermissionRequest`。

## 5. 接入 ChatGPT / Codex 桌面端

Codex 的 hooks 和 Claude Code 是同一套结构。创建 `~/.codex/hooks.json`（已有就按事件名合并）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js codex running", "timeout": 5 }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/approve.js codex", "timeout": 330 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js codex resume", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js codex done", "timeout": 5 }] }
    ],
    "Interrupt": [
      { "hooks": [{ "type": "command", "command": "node /Users/你的用户名/agent-monitor/notify.js codex done", "timeout": 3 }] }
    ]
  }
}
```

- 改完后完全退出再重开 ChatGPT/Codex 桌面端。
- Codex 要求你先审核并信任新加的 hooks；没信任时配置文件看起来完全正确，但运行时会静默跳过。完全退出并重开 ChatGPT/Codex 后，在 Codex 里运行 `/hooks`，信任 agent-monitor 的 5 条 hooks，再运行 `node ~/agent-monitor/doctor.js`，确认出现“Codex：5 条 hooks 已启用并信任”。
- 这些 hooks 是文档里给 Codex 本地客户端用的，但我没有在你的桌面端上实测，第 9 节的测试能告诉你它到底触发没有。

## 6. 在 iPad 上批准

Claude Code 和 Codex 在要弹批准窗口时，会先问 `approve.js`。Needs your action 里对应 App 的卡片会出现这条请求和倒计时。点 **Review & approve** 打开详情（完整命令/参数），里面三个按钮都是**单击**生效：

- **Approve**：单击一次即提交。提交中按钮全部禁用，重复点击、关掉再打开详情都不会重复提交。
- **Deny**：Claude/Codex 会收到“被拒绝”，继续往下走。
- **Handle in app**：立刻放弃在 iPad 上决定，Mac 上会弹出平常的批准窗口。

反馈：只有服务确认决定已送达正在等待的 hook 才显示 “Approved…”。请求已过期、已在 App 里处理、或 hook 已断开时显示 “expired or already handled”，按钮禁用。网络无响应时提示“决定可能未送达，请先在 App 里确认”，不会假装成功。

它做了这些保护：

- **只自动批准下面「自动批准」里列出的那几类。** 其余的，服务没启动、超时（默认 300 秒）、网络断了，都会退回 Mac 上平常的批准窗口。
- 问你问题的类型（比如 Claude 的 `AskUserQuestion`、`ExitPlanMode`）只会提醒你，不会替你回答。
- 没有访问密钥的请求一律拒绝，事件和批准请求只接受来自这台 Mac 本机的连接。

### 一次批准多个

同时有 2 个以上批准请求时，每个请求的标题前有一个勾选框（默认勾上），并且直接显示要运行的命令。顶部的 **Approve selected (N)** 一次批准所有勾上的请求，不想批准的先取消勾选。每个请求仍然单独发送、单独确认；结果汇总成一句提示，比如 “2 approved · 1 expired”。已过期的请求不会被一起批准。

### 自动批准

`approve.js` 会先用 `auto-approve.js` 判断请求。下面这些直接批准，不发到 iPad：

- 只读工具：Read、Glob、Grep、LS
- 在当前项目文件夹里新建、修改文件（Edit、Write）
- 每一部分都是只读命令或常用开发命令的 shell 命令，比如 `ls`、`cat`、`git status/diff/log`、`git add/commit`、`node`、`python3`、`npm test`、`npm run …`、`mkdir`、`cp`、`mv`，而且所有路径都在项目文件夹里

另外自动授权以下精确形式：

- Chrome DevTools：列出标签页、页面快照、截图、读取控制台和网络信息（不保存到文件）。
- 切换已有标签页、等待页面文字（显式超时最多 60 秒）、调整窗口尺寸（每边 1–8192 像素）。这些浏览器操作不要求项目目录；未知参数仍需确认。
- `git pull --ff-only`，以及对 `origin/upstream` 的 `git ls-remote` 查询。快进拉取会修改本地文件，并可能执行已配置的 Git hooks，不是只读操作。

下面这些在项目文件夹里也**照样问你**（走平常的批准，不会直接拒绝）：

- 解释器直接执行命令行里或管道传进来的代码：`node -e/-p/--eval/--print`、`python3 -c`、`ruby -e`、`deno eval`、`bun -e`、`echo … | node`、`node -`。运行项目里的脚本文件（`node script.js`、`python3 tool.py`）照常自动批准。
- 写入路径经过 `..` 或符号链接后落在项目外的（Edit/Write、`cp`、`touch`、`sed -i`、`--out=…` 这类参数）。
- 改 agent 自己的权限和 hook 文件：任何 `.claude/`、`.codex/` 目录，以及 `settings*.json`、`hooks.json`。读取不受影响。
- `git branch` / `git tag` 除列表形式（`git branch`、`-a`、`-r`、`-v`、`--show-current`、`--list 模式`、`--contains X`；`git tag`、`-l`、`-n`）以外的所有写法，包括 `--delete`、`--move`、`--copy`、`-f`、创建新分支或标签。

- Agent Monitor 自己所在的文件夹（规则文件、`token.txt`、日志）：读和写都要问。
- 安装和拉远程代码：`bun` 只放行 `run/test/build`，`go` 只放行 `build/test/vet/fmt/env/version` 和本地路径的 `run`（`go env -w` 要问），`cargo` 只放行 `build/test/check/run`，`deno` 只放行 `run/test/check/fmt/lint/task` 且不能带 `npm:`/`jsr:`/网址；`npm exec` 要问。
- `--inspect` 调试端口只能开在 `127.0.0.1` 或 `localhost`。
- 会写文件、执行命令或丢掉没提交改动的写法：不带参数的 `cd`、`sed` 的 `w/e/r` 命令和 `-f`、`sort -o`、带 getline 或管道的 `awk`、`rg --pre`、`make -f -` / `--eval`、`swift -`、强制或带路径的 `git checkout`、`git restore --worktree`、`git switch -f`、`git mv -f`。

还有：删除、其他联网命令（如 `curl`、普通 pull、push、fetch、安装）、`sudo`、强制覆盖或改写 Git 历史、项目外文件路径、`.git` 写入、重定向、变量与通配符，以及未知工具。浏览器点击、填表、上传、执行脚本或保存输出到文件也不自动放行。

新请求会重新加载规则，无需重启 Monitor；已弹出的旧请求不会补批。这些规则不能取消宿主应用自身的强制审批。验证命令：`node test-auto-approve.js`。

注意：`node`、`python3`、`npm test` 运行的是项目里的代码，代码能做什么，它们就能做什么。这是有意放开的（少收审批）。

**这意味着自动审批只能防 agent 失手，防不了存心使坏的 agent**：agent 可以先写一个脚本（自动批准），再运行它（自动批准）。这个脚本能读 `token.txt`，再调用 `/decide`，把它自己在看板上排队的审批批掉。同样是两步的还有：改 `.husky/pre-commit` 再 `git commit`、改 `package.json` 的 scripts 再 `npm test`、改 `Makefile` 再 `make`。真要防住，需要让 agent 用另一个 macOS 用户运行，读不到这个文件夹。

自动批准会在 `auto-approve.log` 记一行（时间、来源、工具、规则、项目名），**不记命令内容**。要关掉：在 Claude Code / Codex 的启动环境里设 `AUTO_APPROVE=off`。

想改等待时间（默认 300 秒）：`APPROVAL_WAIT_SEC=60 node server.js` 可改回 60 秒。同时把上面配置里的 `timeout` 改成比它大 30 左右。

要知道的代价：等待期间，Claude/Codex 会停在这一步，最长等一个等待时间，才会在 Mac 上出现平常的批准窗口。你如果正坐在 Mac 前，可以在 iPad 上点“回 Mac 处理”，或者把等待时间调短。

## 7. 套餐用量百分比（看板底部 Usage & limits）

看板底部显示 Codex、Claude、Cursor 的「已用」百分比（不是剩余）。Codex/Claude 优先显示每周窗口；Cursor 显示月度额度池，**Cursor models 达到 98% 后改为显示 Other models**（脚注会写 “Other models ·”）。超过 15 分钟未刷新或刷新失败时显示 **Cached · X 前**，不冒充实时数据。

**Claude（当前实现）**：服务每 5 分钟用本机 Claude Code 的登录读取账号用量（`claude-usage.js`，只发往固定的 api.anthropic.com，不打印、不保存凭据）。这是账号级用量，普通 Chat/Cowork 的消耗也计入，但不代表能看到 Chat/Cowork 的任务状态。下面的状态栏方式仍可作为补充：

**Claude**：Claude Code 的状态栏命令会收到一份包含 `rate_limits` 的 JSON（5 小时和 7 天窗口的已用百分比和重置时间）。官方文档写明它只出现在 claude.ai Pro/Max 订阅用户身上，而且要在会话里收到第一次回复之后才有。把状态栏命令指向 `statusline.js`，它会把百分比转发给看板，同时给 Claude Code 显示一行 `Opus · 5h 24% · 7d 91%`。在 `~/.claude/settings.json` 里加：

```json
{
  "statusLine": { "type": "command", "command": "node ~/agent-monitor/statusline.js" }
}
```

- 这会**替换**你现在的 Claude Code 状态栏。如果你已经有自定义的，先告诉我，我帮你合并。
- 只有你在 Claude Code 里完成一轮对话时才会刷新，所以数字是“上次对话结束时”的，卡片上会写“更新于 X 分钟前”。
- 这个百分比是账号级别的，不只是这台 Mac。
- 有用户在 GitHub 上反馈过个别版本的状态栏里 `rate_limits` 消失了。如果一直显示“还没收到用量”，先升级 Claude Code。

**Codex**：服务每 5 分钟会在后台运行一次 `codex app-server`，读取账号的额度窗口，不需要你做任何配置，前提是 Mac 上有 `codex` 命令。

- 如果 `codex` 不在 PATH 里（比如只装了桌面 App、没有命令行版），卡片会写“没找到 codex 命令”。排查：
  1. 终端运行 `which codex`。有输出，说明命令存在，重启服务即可；没有输出，继续。
  2. 运行 `npm install -g @openai/codex` 装命令行版，再运行 `codex login` 用 ChatGPT 账号登录。
  3. 也可以找出已有的：`find /Applications ~/Applications -name codex -type f 2>/dev/null`，找到路径后用 `CODEX_BIN=/路径/codex node server.js` 启动。
  4. 重启服务，等约 10 秒，刷新看板。
- 想关掉这个功能：`CODEX_USAGE=off node server.js`。
- 这一部分我只在沙盒里用一个模拟的 app-server 测过，没有用真正的 Codex 测。它读的是第三方工具和文档里描述的 `account/rateLimits/read`，不是 OpenAI 官方文档里的接口。如果 Codex 版本变了，这里可能失效，失效时只会显示“没读到”，不会影响其他功能。

**Cursor**：服务启动后自动读取本机 Cursor 登录状态，并每 5 分钟查询 Cursor 设置页使用的 `GetCurrentPeriodUsage` 接口。显示 Cursor models 和 Other models 额度池，沿用界面的当前额度池切换规则。无需手工复制凭据；凭据只在内存中使用，只向固定的 Cursor 官方 HTTPS 地址发送，不写进看板或用量缓存。依赖 macOS 自带的 `/usr/bin/sqlite3`。用 `CURSOR_USAGE=off` 可关闭。接口来自已安装的 Cursor 客户端，未来版本可能调整；读取失败会保留最近一次成功数据，`/state` 的 `usageStatus.cursor` 记录状态。

Grok、以及 ChatGPT/Claude 的聊天用量尚未接入。

## 8. iPad 设置

1. Safari 打开带密钥的链接，点「开启提示音」（iPad 必须点一下才允许发声，点完同时会让屏幕保持常亮）
2. 分享 → 添加到主屏幕，之后全屏打开
3. 设置 → 显示与亮度 → 自动锁定 → 永不（如果你想一直挂着）

## 9. 测试

服务跑起来后，在 Mac 终端运行（把 `你的密钥` 换成 `token.txt` 里的内容）：

```bash
KEY=$(cat ~/agent-monitor/token.txt)

curl -X POST localhost:7777/event -H "x-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"source":"claude","session":"t1","project":"demo","status":"running","title":"重构登录页"}'

curl -X POST localhost:7777/event -H "x-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"source":"claude","session":"t1","status":"needs_action","message":"需要你批准运行 npm install"}'
```

iPad 上应该会看到红色卡片。测批准流程：

```bash
echo '{"session_id":"t2","cwd":"/tmp/demo","tool_name":"Bash","tool_input":{"command":"npm install","description":"Install dependencies"}}' \
  | node ~/agent-monitor/approve.js claude
```

iPad 上出现带命令的红色卡片，点 Review & approve，再单击 Approve，终端会打印一行 `allow` 的 JSON；点 “Handle in app” 或等超时，终端什么都不打印。只在这个测试命令上做，不要用真实请求测试。

自动测试（不碰正在运行的服务，使用随机端口和临时目录）：

```bash
cd ~/agent-monitor
for t in test-*.js; do node "$t" || echo "FAILED: $t"; done
```

其中界面测试需要 jsdom（`npm install jsdom`，或用 `JSDOM_PATH=/路径/node_modules/jsdom` 指定）。

## 其他 App

普通的 ChatGPT / Grok 聊天（不是 Codex、不是 Grok Build 命令行）没有 hooks，看板读不到它们的状态。任何能发 HTTP 请求的东西都可以显示在看板上，但要从本机发，并带上访问密钥：

```
POST http://localhost:7777/event      请求头 x-key: <密钥>
{"source":"gpt","session":"任意唯一 ID","status":"running | needs_action | done","title":"任务名"}
```

## 已知限制

- 密钥能批准命令，保管好。它保存在 `token.txt`（权限 600，16 字节随机数的十六进制），想换就删掉这个文件再重启服务，浏览器需要用新密钥重新打开一次。
- 局域网这条路（`MONITOR_HOST=0.0.0.0`）是 http，没有加密。同一个 Wi-Fi 里能抓包的人可以看到密钥和审批内容。只在家里或可信 Wi-Fi 下打开；在咖啡馆、酒店这类公共网络，去掉这个设置。
- Mac 休眠时服务会停，iPad 上会显示「连不上 Mac」，批准也会自动退回 Mac。
- 「运行中」的任务如果被你手动打断，Claude Code 不会发 Stop；30 分钟没有活动后显示 **Status unknown**（不会当作完成），点 Dismiss 即可移除记录。
- 任务太多时，各区按实际高度分页（区块标题右侧的翻页按钮），同一 App 的任务始终在同一张卡片里，不截断文字。
- Claude Code 和 Codex 的 `PermissionRequest` 是在弹窗前触发还是和弹窗并行，我没有在真机上确认。你第一次测时留意一下：Mac 上有没有同时弹出批准窗口。

## Codex 运行状态补偿

后台每 2 秒增量检查本地 Codex 的 `task_started`、`item_completed`、`task_complete` 和中断记录，修复已打开桌面会话漏掉 hooks 时的状态。启动时也会恢复近期仍在运行的任务。只同步任务 ID、项目名和状态时间，不发送聊天内容或工具参数；过滤内部子代理，不导入旧的已完成任务。等待批准的任务保留在 Needs your action。连续 30 分钟没有活动的旧运行记录不会被重新激活。可用 `CODEX_WATCH=off` 关闭补偿；`CODEX_SESSIONS_DIR` 可指定本地日志目录（测试使用隔离目录）。
