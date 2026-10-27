# 已知问题修复与验证

日期：2026-10-24（Asia/Shanghai）。对应 [整体审查](overall-review-2026-10-24.md) 的 R1、R2、R3；结果基于当前工作目录和新生成的 Windows 解包程序。

## 修复结果

| 问题 | 修复后的行为 | 验证 |
| --- | --- | --- |
| R1：迁移交接失败仍启用部分更新的目标目录 | 交接失败时继续使用可用的原目录，显示恢复提示并记录详细诊断；保留迁移指针，下一次启动重试。无法确认安全数据源时停止启动，不创建空库或启用半成品。 | 覆盖 EACCES、ENOSPC、完成标记写入失败、原目录失效、标记损坏、目标消失、成功后移除原目录；真实 Electron 另用自建目录制造 EPERM，确认读取原操作记录，关闭提示不切换目录。 |
| R2：Electron 与构建依赖安全告警 | Electron 更新到 43.8.1；更新 Vite、Vitest、Vue 和受影响间接依赖，修正阻止升级的旧 overrides。 | 全量依赖审计所有严重等级均为 0；冻结锁文件安装通过。新解包程序内嵌运行时实测为 Electron 43.8.1。 |
| R3：离开页面后文件分析持续加载 | 失效当前选择时同步释放加载状态；保留请求编号检查，旧响应不能覆盖或结束新请求；返回页面后可恢复尚未取得结果的选择。 | 覆盖页面停用、旧请求与新请求竞争、清空搜索时取消分析。 |

README 和包描述已与当前功能入口一致，移除仍在提供“空间变化追踪”的描述。另增加独立 Vitest 配置，只收集 `tests/**/*.test.ts`，避免 `.cache` 的研究项目、审查快照及独立复现文件被默认测试误收集。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| Vue / TypeScript | 通过，包含新增测试配置 |
| 正式 Vitest 测试 | 40 文件、311 项通过 |
| 桌面模块语法 | 41 个模块通过 |
| Vite 生产构建 | 43 个模块通过 |
| 冻结锁文件安装 | `pnpm install --frozen-lockfile --ignore-scripts` 退出 0；Electron 已独立安装并运行验证 |
| CI 同门槛审计 | `pnpm audit --audit-level=moderate --json` 退出 0，所有等级告警为 0 |
| Windows 解包构建 | `electron-builder --win --x64 --dir --publish never` 退出 0 |
| 解包程序运行时 | Electron 43.8.1 / Node 24.22.0 / Chromium 150.0.7871.250 |
| 打包程序、深色 1280×900 | 完整进程退出 0；22 张截图、121 条前端检查通过；确认 `packaged: true` |
| 开发程序、浅色 1000×680、迁移失败 | 完整进程退出 0；23 张截图、127 条前端检查通过；确认原目录恢复 |
| 高级搜索 | 两种模式均通过拼音高亮、连续输入、全分页、排序会话、建库期间搜索、缩写召回、高亮刷新 |

解包程序位于 `release/known-issues-fixed/win-unpacked/Disk Sense.exe`。机器可读结果和源码摘要见 [known-issues-fix-validation.json](known-issues-fix-validation.json)；完整桌面截图分别保存在 `release/frontend-full-dark-1280-fixtures-known-fixes-packaged` 和 `release/frontend-full-light-1000-fixtures-known-fixes-migration`。

## 验证边界

本次使用自建数据目录和清理候选夹具，未迁移真实用户数据，未执行用户文件清理、系统维护或外部 AI 请求。两轮界面验收中的执行确认均取消。

生成并验收的是 Windows 解包程序，没有替换既有安装版本、发布安装包或验证 Authenticode 信任、跨 Windows 版本及重启后的长期行为。安全审计表示本次依赖状态没有命中审计库告警，不代表未来没有新公告。

本次修复三个已确认缺陷；原审查中宽查询延迟的性能观察仍保留，没有据此声称达到 Listary 的全盘体验。
