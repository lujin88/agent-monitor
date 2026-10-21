# Claude 通知追踪：权限、实现与验证记录

## 2026-10-02 本机更新（最新记录）

- 安装后新 Reader 已运行，但 App 自身返回 `Operation not permitted (errno 1)`、successfulPolls=0。已向用户请求重新添加此 App 的 Full Disk Access；尚未恢复读取，不把安装完成视为真实链路接通。
- 用户已开启独立 Reader 的完全磁盘访问，旧进程已连续报告 ready，权限读取阶段通过。
- 用户确认使用 Claude **独立桌面 App**，普通 Chat 在后台完成时实际出现系统横幅；但旧 Reader 的 observed/ignored/completed/waiting 均为 0，看板未收到对应事件。此场景目前**未通过端到端验证**，Cowork 和等待输入仍未测试。
- 已复现旧 rowid 游标会漏掉原地更新记录的边界问题。Reader 改用 Claude 精确 App 标识下的记录快照，结合通知修订元数据与标题/类别的内存摘要，识别更新、替换和编号回退。此代码缺陷已修复，但尚不能证明它是上述真实通知丢失的根因。
- 首次启动仅建立基线，不发送历史通知；无变化不重发；本机发送失败保留重试。正文完全不参与摘要或分类。摘要只存内存，状态文件仅增加版本、轮询次数、匹配的 App/记录数量、基线时间。
- Swift 已在这台 Mac 编译，隔离 SQLite 自测通过：只读、精确来源过滤、多 App 条目、启动基线、原地更新、同编号替换、编号回退、失败重试、去重、标题/类别分类、正文变化忽略。没有在自测中读取真实通知数据库或发送真实事件。
- 本次只更新 Reader 及本文档/诊断字段，不改 server.js，不重启看板主服务，不批准任何请求。重新签名后必须以 App 自身的新健康报告确认权限；不要用终端绕过。
- 后续真实测试必须区分“系统横幅出现”“Reader observed 增加”“成功分类”“看板收到”。读到但无法分类时保持 Untracked，不据此猜测完成。所有通知提示仍为 Estimated，无法提供持续运行进度或区分 Chat/Cowork。

下方 2026-10-01 段落保留为历史记录，不代表当前权限状态。

## 当前结论（2026-10-01）

- 本机：macOS 26.6.2，build 25G83。
- 实际数据库：`/Users/lu/Library/Group Containers/group.com.apple.usernoted/db2/db`。
- 文件存在。原程序只读打开返回 `Operation not permitted`；独立 Reader 实测返回 `full_disk_access_required`。
- **尚未完成 Chat 或 Cowork 的真实通知验证，不能声称支持其后台跟踪。**
- Claude Code 已有 hooks 配置。看板区分 hooks 配置与最后任务上报时间；历史上报不等于实时心跳，也不等于目前没有任务。
- 普通 Chat / Cowork 均显示 **Untracked**。旧 Claude 窗口观察记录不再参与看板的任务计数、待处理、完成或运行列表。
- （历史记录）当时按“先改显示，不改采集”的要求，未改 `server.js`，也没有重启服务。2026-10-01 的源码审查对 `server.js` 做了增量修改，见下文“2026-10-01 诊断”与 `CHANGES_2026-10-01.md`。

## 2026-10-01 诊断：为什么仍显示 full_disk_access_required

这次审查在源码副本上完成，**无法在 Mac 上实测**，以下是根据代码得出的结论和待验证项，不是已确认的原因。

**代码层面的证据**

1. 旧版 Reader 把 `sqlite3_open_v2` 的**任何**失败都写成 `full_disk_access_required`，没有保存 errno。所以这个状态本身不能证明是权限没开：文件路径变化（ENOENT）、普通文件权限（EACCES）也会显示成同一个状态。
2. 旧版 `--probe` 与后台进程写同一状态文件，可能相互覆盖。直接启动二进制与通过 App 启动可能有不同的 TCC 归属，但不能只凭父进程 PID 确定。此前已确认后台 App 自身持续写出失败状态，不能把全部失败归因于终端 probe。
3. 后台 Reader 启动时如果已有一个实例在运行，新实例会**静默退出**。如果旧实例是在授权之前启动的，状态文件会一直由旧实例写入。
4. App 为本地 ad-hoc 签名，重新编译或签名可能改变代码身份，导致旧的授权条目不再匹配。这是待验证的可能原因，不是已确认根因。
5. 尚不能排除 macOS 26 对 `group.com.apple.usernoted` 容器有额外保护；没有证据前不作结论。

**这次的修改（未在 Mac 上编译）**

- 打开数据库前先做一次只读 POSIX `open()`，记录 errno（不读取内容），状态文件新增 `openErrno` / `openError`。只有 errno 为 EPERM 时才报告 `full_disk_access_required`，其他情况报告 `database_open_failed`。
- 状态文件新增 `launchedBy` 和 `pid`，只描述启动父进程（PID 1 或其他）；不代表已确定 TCC 权限归属。
- `--probe` 改写到单独的 `notification-reader-probe.json`，不再覆盖后台状态。
- 检测到重复实例时在 stderr 说明原因，而不是静默退出。
- 新增只读脚本 `diagnose-notification-reader.sh`：查看签名类型、运行中的实例及其父进程、两份状态文件的白名单字段。它不打开通知数据库、不读 TCC 数据库、不改任何权限。
- 看板 Connections / Live activity 的覆盖说明显示 Reader 的真实健康状态（例如 “Database access denied (errno 1)”、“Reader stopped”），不再固定写“validation pending”。服务只转发白名单字段，不转发标题、正文或路径。

**需要你在 Mac 上做的步骤（按顺序）**

1. 重新编译 Reader（你原来的编译命令），然后运行 `bash ~/agent-monitor/diagnose-notification-reader.sh`，记录输出。
2. 在“活动监视器”里退出所有 “Agent Monitor Notifications” 进程。
3. 系统设置 → 隐私与安全性 → 完全磁盘访问权限：用“−”移除旧的 “Agent Monitor Notifications” 条目，再用“+”添加 `~/agent-monitor/Agent Monitor Notifications.app`。
4. 在 Finder 里双击启动这个 App（或运行 `open ~/agent-monitor/"Agent Monitor Notifications.app"`）。**不要**直接在终端运行 `Contents/MacOS` 里的可执行文件。
5. 等 10 秒，再运行一次诊断脚本。看 `notification-reader-status.json` 中的 `openErrno` 和 `launchedBy`：
   - `launchedBy: launchd` 且没有 `openErrno`，状态为 `ready` / `no_claude_notifications`：可读，可以开始下面的实测。
   - `openErrno: 1`：系统拒绝访问。隐私权限是可能原因，不能凭 PID 或 errno 单独确定具体 TCC 归属。
   - `openErrno: 2`：数据库路径在这个 macOS 版本上不同，需要另行确认路径，不要扩大扫描范围。
6. 不要为此给终端、Node、Python 或 Claude 开 Full Disk Access。

## 独立程序

应用：`/Users/lu/agent-monitor/Agent Monitor Notifications.app`

源代码：`/Users/lu/agent-monitor/NotificationReader.swift`

应用标识：`com.lu.agent-monitor.notifications`

Claude 筛选标识：`com.anthropic.claudefordesktop`

程序后台每 3 秒尝试一次只读查询。每次启动在现有通知末尾建立起点，不导入旧通知。它不会自动登录、点击、发消息、批准请求、改变任何权限或修改通知数据库。

## 由用户授予的权限

仅需要将 **Agent Monitor Notifications.app** 加到 System Settings → Privacy & Security → **Full Disk Access**。请不要为此给 Terminal、Python、Node、Claude 或其他程序增加权限。

Full Disk Access 是 macOS 的广泛文件访问权限，不能在系统设置中缩小为“只读 Claude 通知”。程序本身限制查询范围为上述数据库中 Claude 的记录，并用 SQLite READONLY + query_only 打开。

不申请 Accessibility、Screen Recording、Automation、麦克风、相机或发送系统通知的权限。它不绕过权限提示，不复制受保护的数据库到其他位置。

## 数据与网络边界

- macOS 把通知内容打包在二进制 plist 中，读取记录时该数据会进入进程内存。
- 程序仅使用标题（titl/title）与分类（cate/categoryIdentifier/category）；不使用正文、附件或 userInfo，不写入、不打印、不转发正文。
- 不记录原始标题或分类内容；本机状态文件仅存健康状态、计数和时间，不存通知正文或标题。
- 唯一 HTTP 目的地址写死为 `http://127.0.0.1:7777/event`。不访问外网，不解析远程域名，不跟随重定向、不使用代理，也没有可更换远程主机的配置。
- 发送的是程序生成的英文标题、估算类型和本地通知序号，不含通知原始文本。原始通知内容不会送到 iPad、模型、遥测或外部服务。
- 本地看板 token 只在内存里作为本机请求的认证头使用，不打印、不复制保存。
- `notification-reader-status.json` 是 0600 权限的健康报告；不是正文日志。

## 事件含义与限制

- 标题包含 `waiting for your input` / `needs your input` 或匹配明确的等待分类 → **Needs action，Estimated**。
- 明确的任务/回复完成标题或分类 → **Ready to review，Estimated**。
- 只有正文包含这些词：忽略。不能为了提高命中率去读取正文。
- 未识别的标题/分类：只增加 ignored 计数，不猜任务状态。
- 通知通常无法区分 Chat 与 Cowork，也无法可靠对应某一会话，因此不冒充某个聊天的精确状态。
- 估算通知有虚线、不同颜色以及 Estimated 标记；不是完成百分比，也不提供直接授权按钮。
- 等待通知与完成通知是独立提示，不凭名称把它们自动合并成同一个任务。用户可移除旧提醒。
- 正在查看会话时通知可能被抑制。Focus、系统通知设置、系统保留规则也可能影响覆盖。无通知绝不等于无任务或已完成。
- 当前 Reader 手动启动，不安装开机自启。退出/停机期间的事件不会追补；启动前的旧通知也不会导入。
- 该数据库格式是系统实现细节。实测 schema 不匹配时停止并显示 unsupported_schema，不进行宽泛扫描。

## 已执行的本地测试

- 真正的只读 SQLite fixture：仅提取 Claude app_id 的记录，其他 App 的记录排除。
- SQLite 写入操作返回 READONLY。
- cursor / baseline 查询不重放已读记录。
- 等待与完成标题、明确分类正确映射。
- 普通对话标题不会被当作完成事件；正文中包含等待短语也不会被使用。
- 网页来源区分、旧界面记录排除、未追踪来源、任务分组和授权按钮回归测试通过。
- 安装后 HTTP 返回的 HTML 与新文件一致；server.js 哈希未变。

以上是逻辑测试，**不等于 Chat / Cowork 实测成功**。

## 待执行实测（用户控制）

先等健康报告为 ready / no_claude_notifications（可读，但尚无对应记录）。不要在权限未生效前开始测试。

1. 记录 Reader 的计数与时间。
2. 用户在普通 Chat 发一条需要较长回复的消息，立刻切到其他 App，保持 Mac 唤醒。
3. 用户报告系统横幅/通知中心是否出现通知；程序比较 Claude 通知计数、分类计数和看板事件。
4. 单独对 Cowork 重复一次，不能同时跑两个测试，以免无法归因。
5. 若能触发“waiting for your input”，单独测试等待通知。测试完成通知不能替代等待场景。
6. 对仍停留在会话界面的情形做对照。未收到通知只记为“本次未观察到”，不声称所有时候都不会通知。

| 场景 | 系统通知实际出现 | Reader 读到 | 看板收到 | 结论 |
|---|---|---|---|---|
| Chat 后台完成 | 未测 | 未测 | 未测 | 不确定 |
| Chat 等待输入 | 未测 | 未测 | 未测 | 不确定 |
| Cowork 后台完成 | 未测 | 未测 | 未测 | 不确定 |
| Cowork 等待输入 | 未测 | 未测 | 未测 | 不确定 |
| 正在查看会话的对照 | 未测 | 未测 | 未测 | 可能受抑制，待测 |
