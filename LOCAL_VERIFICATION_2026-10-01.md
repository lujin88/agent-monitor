# Mac 本机复核与部署（2026-10-01）

## 实际已完成
- 16 个被修改文件的原始副本与部署前 Mac 源码逐字节一致。
- 完整本地备份：~/agent-monitor-backup-reviewed-20261001-232806。备份目录权限为 0700。
- 18 个测试文件在 Mac 上通过；集成测试使用隔离端口、临时目录和合成数据，不批准真实请求。
- 追加并复现审批边界问题：提交后关闭并重开弹窗，网络失败时新弹窗不恢复。修复后失败恢复和成功关闭测试均通过。
- Swift Reader 在 Mac 上编译成功，--self-test 通过；App 签名完整性验证通过。
- 应用页面、服务及诊断修复。重启前两次检查均为 0 pending approvals，仅重启现有 com.lu.agent-monitor 服务。
- /state 已实际提供 reports、hookConfig、通知 Reader 的白名单健康字段。窗口观察默认 disabled。
- HTTP 实际返回的 HTML 与安装文件一致；Chrome 已刷新。
- 当前真实数据下 Chrome 检查了 1920×958、768×1024、1024×768，无页面整体溢出，检查的标题、元信息、来源说明及用量脚注没有尺寸溢出。不是实体 iPad Safari 测试，也不替代三软件满载实测。

## 仍需用户配合的真实连接验证
- 新 Reader 已从 App 启动并持续更新健康报告，但 POSIX 只读打开返回 errno 1 / Operation not permitted，尚未读取通知。
- 父进程为 launchd 仅是启动上下文，不足以证明 TCC 归属；errno 1 说明拒绝访问，不能单独确认具体权限根因。
- 更新本地 ad-hoc 签名 App 后，旧授权条目可能不再匹配。由用户在 Full Disk Access 移除旧条目并重新添加当前 Agent Monitor Notifications.app；不要授权 Terminal/Node/Python，不修改 TCC 数据库。
- Chat / Cowork 完成及等待输入通知均未实测，保持 Untracked / Estimated 标识。无通知不代表没有任务。
- 页面当前 Claude 用量仍显示缓存和 Sign in to Claude Code，这是独立的用量认证问题，本轮没有替用户登录。

## 回滚
从上述备份恢复本次修改的源码或 Reader App，保留当前 token.txt、state.json、usage.json、reports.json 等运行数据。若恢复 server.js，先确认没有待审批请求再重启现有服务，不新建第二个实例。
