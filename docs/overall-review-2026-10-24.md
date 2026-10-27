# 整体审查与测试

后续状态：下文 R1、R2、R3 已完成修复并复验，见 [已知问题修复与验证](known-issues-fix-2026-10-24.md)。本文保留修复前的复现、测量及历史验证结果。

日期：2026-10-24（Asia/Shanghai）。审查对象为当前工作目录，包括尚未提交的修改和新增模块。此次审查没有修改业务实现、更新依赖或执行用户文件清理、系统维护、真实数据迁移。

结论：现有自动化与桌面正常流程通过，但确认了两个功能缺陷和一个需优先处理的运行时安全问题。不能将现有 301 项测试通过理解为全部故障分支正确或依赖安全。

## 确认的问题

### R1 / P1：迁移交接失败后仍使用部分更新的目标目录

位置：`desktop/app-settings.cjs:133`；失败返回在 `114` 行，逐文件交接在 `91–103` 行。

`finalizePendingMigration()` 按文件逐个覆盖目标；遇到错误时返回 `{ finalized: false, error }`。`resolveDataLocation()` 忽略这个返回值，继续将 `userDataPath` 指向目标。

已在自建目录复现：先复制设置和操作记录，再修改源数据，模拟迁移后的首次启动；仅向目标操作记录的交接 rename 注入 `EACCES`。启动解析正常返回，目标设置已是新版本，操作记录仍是迁移前版本，调用方没有得到错误，迁移标记也没有完成。

实际影响：权限或磁盘故障下，应用可在不提示用户的情况下读取混合版本的数据。源目录仍保留，故不能声称数据已物理丢失；但最新记录会在当前启动中不可见，并可能在后续写入、重试时形成数据分歧。

建议：将交接失败传递给启动流程，保留或回退到一致的源目录；成功校验完整交接后再启用目标。增加多文件交接部分失败、磁盘不足及重试场景测试。

复现命令：`node .cache/overall-audit-probes.cjs`。原始结果见 `.cache/overall-audit-probes.json`，摘要已保存在正式验证 JSON。

### R2 / P1：交付运行时 Electron 43.7.7 命中已公开的 TLS 安全问题

位置：`package.json:34`。已读取本地 `electron.exe` 文件版本，确为 `43.7.7`。

Electron 官方的 [GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9) 指出该版本缺少针对已受损 eMudhra 中间证书的阻断，43 分支的修复版本为 `43.8.1`。该问题要求攻击者持有相关证书并能截获网络连接；不能描述为应用已被入侵。本项目的 AI 功能会通过 Electron 主进程的 `fetch` 建立 HTTPS 连接，因此存在相关执行路径。

全量 `pnpm audit --json`：20 项命中记录，7 高危、10 中危、3 低危；这些不等于 20 个独立 CVE。当前 `.github/workflows/ci.yml:31` 使用的 `pnpm audit --audit-level=moderate` 已在本机实际执行，退出码为 1。

`pnpm audit --prod --json` 为零，但不能据此判定交付运行时无漏洞：Electron 在 manifest 中属于开发依赖，实际会随桌面程序交付。其他命中需按执行路径判断：Vite/launch-editor 影响 Windows 开发服务，部分 undici 来自下载/构建链；本项目没有生产 SSR 入口，不能把 `@vue/server-renderer` 的公告直接等同为当前桌面存在可利用的 SSR XSS。

建议先更新 Electron 到同分支修复版，再更新开发/构建依赖并复跑打包、搜索与桌面回归。Vite 的 Windows 问题及修复范围可核对 [维护方公告](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm)。此次没有执行依赖升级。

### R3 / P2：分析未完成时切走页面，会遗留加载状态

位置：`src/ui/ExplorerWorkspace.vue:1417`、`1420`、`1070`。

`selectItem()` 设置 `refreshingExplanation = true`；KeepAlive 的 `stopActiveWork()` 递增 `selectionRequestId` 使旧响应失效，却不重置该加载标志。旧请求结束时，finally 因请求 ID 不同而跳过复位。返回页面时没有新选择操作，加载状态会持续；有预览内容时 AI 按钮也会保持禁用，直到重新选择文件。

使用真实 Vue 组件 setup、可控延迟的解释请求及页面停用方法复现。补充的期望行为测试要求失效请求结束后不再加载，实际得到 `true`，故意保留该审查测试失败结果。

建议：在停用或主动取消当前选择时同步结束其加载状态，并保留请求 ID 检查，避免旧请求复位新请求的状态。

隔离复现命令：

```powershell
node node_modules/vitest/vitest.mjs run --config .cache/overall-audit-vitest.config.mjs --configLoader runner --maxWorkers=1 --testTimeout=15000
```

该用例位于 `.cache/overall-audit-reproductions.test.ts`，不加入默认产品测试集。预期退出码为 1；默认 301 项测试仍全部通过。

## 已完成的检查

| 检查 | 当前结果 | 边界 |
| --- | --- | --- |
| Vue / TypeScript 类型检查 | 通过 | 当前源码 |
| Vitest 完整测试 | 40 文件、301 项通过 | 包括搜索会话、清理安全、AI 协议夹具、状态与维护白名单 |
| 桌面模块语法检查 | 41 个模块通过 | 不代表所有系统调用已实际执行 |
| Vite 生产构建 | 43 个模块通过 | 不是安装包发布 |
| 差异空白检查 | `git diff --check` 退出 0 | 行尾转换提示不属于失败 |
| 生产资源加载 | 真实 Electron、深色 1280×900，通过 | 加载当前 dist；使用开发运行时，不是 NSIS 安装产物 |
| 开发资源加载 | 真实 Electron、浅色 1000×680，通过 | Vite / preload / IPC 实际运行 |
| 完整页面验收 | 44 张截图、242 条前端检查通过 | 四个工作区、子页、弹窗、焦点、清理四种扫描状态；所有执行确认均取消 |
| 高级搜索 | 两种运行方式均通过 | 拼音高亮、连续输入、全分页、排序会话、缩写召回、高亮刷新、建库期间搜索 |
| NTFS | 当前自动服务运行，C、D 盘只读 probe 成功 | 没有安装/启用服务、触发 UAC、重建全盘或重启 Windows |
| 依赖 | 全量审计失败，生产 npm 依赖审计为零 | 运行时 Electron 需单独计入交付风险 |
| 故障补充 | 迁移缺陷复现；加载状态期望测试失败 | 两项均未在本次审查中修复 |

本机使用 Node `22.22.3`、pnpm `11.9.0`、Electron `43.7.7`。SQLite ExperimentalWarning 没有导致测试失败。

## 性能观察

使用项目现有性能脚本，在自建的 5,000 文件目录中测试 portable 枚举，返回上限为每次 300 项。单独复测：

- 收录 5,022 个条目，用时 2,222 ms；主线程计时器最大延迟 15.8 ms。
- 搜索请求中位数 37.6 ms，P95 275.5 ms；单次最大 544 ms。
- 宽查询 `project` 的中位数 139.8 ms；`*.docx` 为 206 ms。缩写 `prj777` 为 1.8 ms。

这说明泛词和大结果查询仍有明显等待，应继续分解召回、排序、展示和索引补充阶段。该脚本测量工作线程服务调用，包含最多 300 条结果，不是 GUI 首屏延迟；可能包含首次查询与后台索引工作，系统其他进程没有隔离。不能据此声称已达到 Listary，也不能将 5,000 文件结果外推到全盘规模。另一次与桌面验收并行的测量更慢，正式 JSON 同时保留两组结果。

## 其他观察与未验证项

- README 当前版本描述仍提到“空间变化追踪”，而当前四个可见工作区已经没有该入口；后台 changes IPC 和旧记录仍在。应统一产品说明与实际入口。
- 没有实际调用外部 AI 供应商、消耗真实额度或发送用户文件证据；AI 协议通过本地夹具验证。
- 没有执行垃圾清理、DISM、休眠切换、ResetBase、卸载/重装或真实数据迁移。
- 没有新建安装包、验证 Authenticode、重启后 USN 回放，或进行跨 Windows 版本、长时间压力验证。
- 未查询远端 CI 状态；本报告只说明本地检查和同配置安全门槛的实际结果。

机器可读证据、源码摘要、审计命中列表和命令见 [overall-review-validation.json](overall-review-validation.json)。审查过程只增加该报告、验证 JSON 和 `.cache` 内的隔离复现材料。
