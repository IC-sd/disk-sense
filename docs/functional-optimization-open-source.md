# 功能设计、逐项优化与开源项目对照

研究日期：2026-10-24（Asia/Shanghai）。通过 Exa 检索 65 条候选结果记录，去重和筛选后核对 25 个项目。结合源码拆分为 18 项能力。下文保留研究时的设计及验收目标；2026-10-27 已落实一轮实现与测试，逐项结果及剩余边界见 [实现与验收报告](functional-implementation-2026-10-27.md)。机器可读目录、版本和源码摘要见 [functional-optimization-catalog.json](functional-optimization-catalog.json)。

当前产品保留“空间概览、目录与文件、垃圾清理、设置与关于”四个工作区。优化沿着“查看占用 → 找到对象 → 理解用途与风险 → 预览并决定处理”展开。MFT/USN、候选会话、虚拟列表、安全候选标识、数据迁移回退等已经存在，本次据源码列出其进一步改进目标。

## 逐项设计

P0 优先确保数据、任务恢复和核心结果完整；P1 补齐覆盖、可维护性及交互；P2 在基础稳定后改善体验。优先级是实施建议，不代表本轮复现了同等级漏洞。

| 编号 | 功能 | 优先级 | 优化重点 | 相关开源项目 |
| --- | --- | --- | --- | --- |
| F01 | [空间概览与容量计量](#f01) | P2 | 在目录详情提供按需的占用钻取；建立逻辑大小、实际分配大小与估算状态字段，按文件身份处理硬链接、稀疏/压缩和云占位；首页继续聚焦容量与入口。 | [windirstat](https://github.com/windirstat/windirstat) |
| F02 | [目录浏览、收藏与导航](#f02) | P1 | 引入目录会话与可取消的分批枚举，明确部分/完成状态；完整名称快照与按页元数据分离，排序和筛选基于同一目录会话；返回目录保留滚动与选择。 | [Files](https://github.com/files-community/Files)、[virtual](https://github.com/TanStack/virtual) |
| F03 | [全盘索引、NTFS 服务与增量维护](#f03) | P0 | 评估按卷构建影子索引代际，校验完成再发布；为 USN 批次建立可恢复检查点和幂等回放证明，游标只在对应更新提交后推进；保留现有服务和普通枚举回退。 | [UltraFastFileSearch](https://github.com/skyllc-ai/UltraFastFileSearch)、[Files](https://github.com/files-community/Files) |
| F04 | [查询语义、拼音、召回与排序](#f04) | P1 | 保留现有完整召回、排名列复用与按页归并；扩充真实常用词和困难词样本，关联召回/评分/排序/物化/IPC/首屏耗时；按实测瓶颈评估选择率估计、共享评分或原生紧凑原型。 | [nucleo](https://github.com/helix-editor/nucleo)、[fzf](https://github.com/junegunn/fzf) |
| F05 | [搜索结果、图标与键盘操作](#f05) | P1 | 统一结果视图快照与 item identity；批次只更新可见窗口，排序切换使用稳定会话；有界缓存图标，错误和未完成结果给出可理解状态。 | [virtual](https://github.com/TanStack/virtual)、[Flow.Launcher](https://github.com/Flow-Launcher/Flow.Launcher) |
| F06 | [本地文件类型与用途解释](#f06) | P1 | 为各类证据标注来源、置信与冲突；以有界 buffer 增强二进制识别，文本与目录结构保持独立；解释与可清理资格继续分别判断。 | [file-type](https://github.com/sindresorhus/file-type)、[syft](https://github.com/anchore/syft) |
| F07 | [应用归属与项目关系](#f07) | P1 | 拆出可缓存的应用来源提供器；区分安装身份、项目根、组件和数据角色；参照 cataloger 分生态解析清单，保留冲突和缺失来源。 | [Bulk-Crap-Uninstaller](https://github.com/BCUninstaller/Bulk-Crap-Uninstaller)、[syft](https://github.com/anchore/syft) |
| F08 | [AI 接入、协议与取消](#f08) | P2 | 按能力声明请求/解析适配器，集中处理结构化输出、错误、取消与可重试条件；保留手动请求与成本边界，按真实兼容性结果决定是否引 SDK。 | [ai](https://github.com/vercel/ai)、[promptfoo](https://github.com/promptfoo/promptfoo) |
| F09 | [AI 证据、结果缓存与质量评估](#f09) | P1 | 建立人工夹具和预期事实；输出字段关联证据编号，缺证据时表达不确定；增加模型/提示版本及证据版本，单独评估事实质量和确定性安全不变量。 | [promptfoo](https://github.com/promptfoo/promptfoo)、[ai](https://github.com/vercel/ai) |
| F10 | [垃圾清理规则设计与版本管理](#f10) | P1 | 将识别条件、位置提供器、保留期、保护条件、来源及版本声明化；动作限定为主进程已注册能力；规则先通过校验和预览夹具再启用。 | [bleachbit](https://github.com/bleachbit/bleachbit)、[cleanerml](https://github.com/bleachbit/cleanerml) |
| F11 | [垃圾扫描、应用发现与覆盖报告](#f11) | P1 | 建立共享扫描会话与占用账本，读取一次后按 matcher 分发；每条规则保留自身保护条件、来源与覆盖状态；用背压控制并发和进度更新。 | [czkawka](https://github.com/qarmin/czkawka)、[bleachbit](https://github.com/bleachbit/bleachbit) |
| F12 | [安全清理执行与中断恢复](#f12) | P0 | 执行前持久化计划；逐项记录 prepared/attempted/confirmed/failed/uncertain；恢复时重新核验文件身份，向用户展示未确认项；评估原生批处理时保留逐文件保护。 | [Files](https://github.com/files-community/Files)、[sqlite](https://github.com/sqlite/sqlite) |
| F13 | [开发工具与包管理器缓存](#f13) | P1 | 定义工具提供器：检测可执行文件/版本、查询实际位置、解释容量、预览原生命令；按安装版本选能力，明确共享存储和重新下载成本。 | [pnpm](https://github.com/pnpm/pnpm)、[uv](https://github.com/astral-sh/uv) |
| F14 | [系统瘦身与 Windows 官方维护](#f14) | P1 | 按作业建模检查/执行/退出/待重启，规范管理员权限、进度和日志；检测占用与实际可释放估计分开，保留官方设置跳转。 | [DISMTools](https://github.com/CodingWonders/DISMTools) |
| F15 | [任务历史、结果审计与恢复入口](#f15) | P0 | 在现有 SQLite 技术栈上评估独立作业表和追加事件表；进度与持久状态分离，历史按需分页，保留任务/候选/证据版本关联 ID。 | [sqlite](https://github.com/sqlite/sqlite)、[electron-log](https://github.com/megahertz/electron-log) |
| F16 | [设置、凭据、本地状态与数据迁移](#f16) | P1 | 采用唯一临时文件、受控写入队列和同步策略；迁移使用代际清单、校验和、明确完成标记与原目录保留；数据增长按类型限额和分页。 | [write-file-atomic](https://github.com/npm/write-file-atomic)、[sqlite](https://github.com/sqlite/sqlite) |
| F17 | [整体交互、主题与无障碍](#f17) | P1 | 统一任务状态呈现、对话框/抽屉、快捷键及选择反馈；评估无样式可访问组件，保持当前信息架构；复杂技术细节按需展开。 | [reka-ui](https://github.com/unovue/reka-ui)、[virtual](https://github.com/TanStack/virtual) |
| F18 | [诊断、回归测试与安装交付](#f18) | P0 | 按操作关联各阶段日志，脱敏导出最小复现资料；将真实 Electron、性能集合对照、安装升级和 VM 故障场景分层；评估生产 fuses 并验证所有辅助进程。 | [electron-log](https://github.com/megahertz/electron-log)、[playwright](https://github.com/microsoft/playwright)、[fuses](https://github.com/electron/fuses)、[electron-builder](https://github.com/electron-userland/electron-builder) |

<a id="f01"></a>
### F01 空间概览与容量计量

**当前实现：** 已显示卷容量、剩余空间、使用率和浏览入口；处理记录默认折叠。

**待完善点：** 卷总量和目录文件大小使用不同口径；用户定位占用时还缺统一的逻辑/实际分配说明。

**设计：** 在目录详情提供按需的占用钻取；建立逻辑大小、实际分配大小与估算状态字段，按文件身份处理硬链接、稀疏/压缩和云占位；首页继续聚焦容量与入口。

**验收：** 硬链接、稀疏、压缩、云占位和回收站样本分别校验；估算结果有明确状态，避免将移入回收站计为已释放。

**落点：** [desktop/system-info.cjs](../desktop/system-info.cjs)、[src/ui/OverviewWorkspace.vue](../src/ui/OverviewWorkspace.vue)。

<a id="f02"></a>
### F02 目录浏览、收藏与导航

**当前实现：** 已有导航历史、收藏、筛选排序、懒元数据、目录大小估算与虚拟展示。

**待完善点：** MAX_ITEMS 为 5000，listDirectory 返回截断标志；虚拟渲染不能补回尚未枚举的条目。

**设计：** 引入目录会话与可取消的分批枚举，明确部分/完成状态；完整名称快照与按页元数据分离，排序和筛选基于同一目录会话；返回目录保留滚动与选择。

**验收：** 5 万项目录可继续加载到完整；排序、过滤与返回导航不遗漏已存在对象；快速切换和目录变更不会把旧批次接入新目录。

**落点：** [desktop/explainer.cjs](../desktop/explainer.cjs)、[src/application/explorer.ts](../src/application/explorer.ts)、[src/ui/ExplorerWorkspace.vue](../src/ui/ExplorerWorkspace.vue)。

<a id="f03"></a>
### F03 全盘索引、NTFS 服务与增量维护

**当前实现：** 已有 MFT 快照、USN 回放、卷/日志身份、持久服务和普通枚举回退；更新分批提交，游标在回放末尾保存。

**待完善点：** 快照直接分批更新现有表，USN 回放跨多个事务；中途退出后的重放幂等性与查询视图一致性需要专项验证。首次与非 NTFS 收录仍有成本。

**设计：** 评估按卷构建影子索引代际，校验完成再发布；为 USN 批次建立可恢复检查点和幂等回放证明，游标只在对应更新提交后推进；保留现有服务和普通枚举回退。

**验收：** 虚拟机中覆盖重启、服务重启、USN JournalID 变化、卷拔插、目录移动、硬链接和百万级变更；对照目录枚举校验集合完整性，不仅测耗时。

**落点：** [desktop/file-search.cjs](../desktop/file-search.cjs)、[desktop/ntfs-index.cjs](../desktop/ntfs-index.cjs)、[desktop/ntfs-client.cjs](../desktop/ntfs-client.cjs)、[desktop/ntfs-indexer.cs](../desktop/ntfs-indexer.cs)、[desktop/ntfs-service.cs](../desktop/ntfs-service.cs)。

<a id="f04"></a>
### F04 查询语义、拼音、召回与排序

**当前实现：** 已有多词、扩展名、路径、拼音和缩写；完整 ID 召回后的排名列复用、同快照读取、分区归并与会话预算已实现。

**待完善点：** 宽查询仍涉及大量候选评分和排序；现有排名列复用不减少完整召回，既有阶段诊断也未覆盖全部 GUI 等待。

**设计：** 保留现有完整召回、排名列复用与按页归并；扩充真实常用词和困难词样本，关联召回/评分/排序/物化/IPC/首屏耗时；按实测瓶颈评估选择率估计、共享评分或原生紧凑原型。

**验收：** 所有排序与全分页的集合和稳定次序通过对照；新旧索引、中文高亮、输入删除/否定与缩写均覆盖；报告冷/热 P50/P95、内存和 GUI 首屏。

**落点：** [desktop/search-query.cjs](../desktop/search-query.cjs)、[desktop/search-engine.cjs](../desktop/search-engine.cjs)、[desktop/search-word-index.cjs](../desktop/search-word-index.cjs)、[desktop/search-session-cache.cjs](../desktop/search-session-cache.cjs)。前置能力：F03。

<a id="f05"></a>
### F05 搜索结果、图标与键盘操作

**当前实现：** 选择与分析已分开；支持打开/定位/复制、分页、图标懒取和快捷键。

**待完善点：** 快速输入、排序、分页和图标到达时，需要持续保持选择身份、滚动位置及当前查询的一致性。

**设计：** 统一结果视图快照与 item identity；批次只更新可见窗口，排序切换使用稳定会话；有界缓存图标，错误和未完成结果给出可理解状态。

**验收：** 10 万候选下连续输入、上下键/PageUp/PageDown、排序与翻页不误开文件；图标与旧响应不覆盖新查询，真实 Electron 验证。

**落点：** [desktop/search-candidate-session.cjs](../desktop/search-candidate-session.cjs)、[desktop/search-result-view.cjs](../desktop/search-result-view.cjs)、[desktop/file-actions.cjs](../desktop/file-actions.cjs)、[src/ui/ExplorerWorkspace.vue](../src/ui/ExplorerWorkspace.vue)。前置能力：F04。

<a id="f06"></a>
### F06 本地文件类型与用途解释

**当前实现：** 已有路径、名称、父/同级结构、文件头和有限文本预览，内容读取上限 32 KiB。

**待完善点：** 扩展名、签名与目录角色是不同证据；现有手工签名集合覆盖面有限。

**设计：** 为各类证据标注来源、置信与冲突；以有界 buffer 增强二进制识别，文本与目录结构保持独立；解释与可清理资格继续分别判断。

**验收：** 伪扩展名、损坏文件、SQLite、PE、Office 容器和超大文件均不触发无界读取；格式识别不能降低已知数据风险。

**落点：** [desktop/explainer.cjs](../desktop/explainer.cjs)、[desktop/risk.cjs](../desktop/risk.cjs)。

<a id="f07"></a>
### F07 应用归属与项目关系

**当前实现：** 读取 HKLM/HKCU 卸载登记，结合安装路径、常见应用位置和多生态项目标记。

**待完善点：** Store/MSIX、便携应用、自定义资料目录与多版本安装的归属覆盖仍需补充。

**设计：** 拆出可缓存的应用来源提供器；区分安装身份、项目根、组件和数据角色；参照 cataloger 分生态解析清单，保留冲突和缺失来源。

**验收：** 同名产品、共享父目录、跨盘数据、便携版、多用户登记与嵌套项目样本均可解释来源；读取项目清单不执行安装脚本。

**落点：** [desktop/windows-app-inventory.cjs](../desktop/windows-app-inventory.cjs)、[desktop/app-attribution.cjs](../desktop/app-attribution.cjs)、[desktop/relationship-engine.cjs](../desktop/relationship-engine.cjs)。前置能力：F06。

<a id="f08"></a>
### F08 AI 接入、协议与取消

**当前实现：** 已支持多协议、HTTPS 约束、超时取消、手动模型列表和本地凭据加密。

**待完善点：** 不同提供器的能力和错误格式会变化，兼容修补若散落于业务逻辑会增加维护成本。

**设计：** 按能力声明请求/解析适配器，集中处理结构化输出、错误、取消与可重试条件；保留手动请求与成本边界，按真实兼容性结果决定是否引 SDK。

**验收：** 每种协议通过本地响应夹具；超时、限流、认证失败、畸形 JSON 与取消不产生重复请求；真实端点验收单独记录。

**落点：** [desktop/ai-provider.cjs](../desktop/ai-provider.cjs)、[desktop/ai-explainer.cjs](../desktop/ai-explainer.cjs)、[desktop/handlers/inspect-handlers.cjs](../desktop/handlers/inspect-handlers.cjs)。

<a id="f09"></a>
### F09 AI 证据、结果缓存与质量评估

**当前实现：** 证据脱敏裁剪，分析按路径和指纹保存，重用前复核；本地风险优先。

**待完善点：** 协议测试不等于用途解释质量；需要可重复比较的事实、风险、注入与过期样本。

**设计：** 建立人工夹具和预期事实；输出字段关联证据编号，缺证据时表达不确定；增加模型/提示版本及证据版本，单独评估事实质量和确定性安全不变量。

**验收：** 文件内容中的指令按数据处理；秘密不进入请求或日志，AI 不改变删除资格；变更后的证据不重用旧分析，评分结果可复现。

**落点：** [src/application/ai-evidence.ts](../src/application/ai-evidence.ts)、[src/application/ai-session.ts](../src/application/ai-session.ts)、[desktop/ai-analysis-store.cjs](../desktop/ai-analysis-store.cjs)、[desktop/ai-explainer.cjs](../desktop/ai-explainer.cjs)。前置能力：F06、F07、F08。

<a id="f10"></a>
### F10 垃圾清理规则设计与版本管理

**当前实现：** 28 条内置规则，具备风险、保留期、进程保护、只检测状态与排除项。

**待完善点：** 规则主要位于代码对象中；扩充应用时需要一致的 schema、来源和正反样本管理。

**设计：** 将识别条件、位置提供器、保留期、保护条件、来源及版本声明化；动作限定为主进程已注册能力；规则先通过校验和预览夹具再启用。

**验收：** 无效规则拒绝加载；每条新增规则有应用版本、可重建依据和保护样本；目录重命名、资料目录和配置文件不被宽匹配纳入。

**落点：** [desktop/cleaner.cjs](../desktop/cleaner.cjs)、[desktop/cleanup-discovery.cjs](../desktop/cleanup-discovery.cjs)、[src/application/cleaner.ts](../src/application/cleaner.ts)。

<a id="f11"></a>
### F11 垃圾扫描、应用发现与覆盖报告

**当前实现：** 有预算、取消、单规则根目录去重、覆盖状态和跨规则执行去重。

**待完善点：** 跨规则共享父目录仍会重复遍历；包管理器配置发现的警告尚未完全汇入统一覆盖说明。

**设计：** 建立共享扫描会话与占用账本，读取一次后按 matcher 分发；每条规则保留自身保护条件、来源与覆盖状态；用背压控制并发和进度更新。

**验收：** 共享目录不重复计量，不丢失较严格保护条件；权限错误、预算耗尽和未安装能区分；取消后保留已确认结果与覆盖问题。

**落点：** [desktop/cleaner.cjs](../desktop/cleaner.cjs)、[desktop/cleanup-discovery.cjs](../desktop/cleanup-discovery.cjs)、[desktop/operation-coordinator.cjs](../desktop/operation-coordinator.cjs)。前置能力：F10。

<a id="f12"></a>
### F12 安全清理执行与中断恢复

**当前实现：** 短期候选 ID、执行前身份/路径/进程复核、回收站处理与逐文件进度已实现。

**待完善点：** 任务结果在 executeCleanupPlan 完成后保存；中途进程崩溃的持久化审计与未确认结果需要专门处理。

**设计：** 执行前持久化计划；逐项记录 prepared/attempted/confirmed/failed/uncertain；恢复时重新核验文件身份，向用户展示未确认项；评估原生批处理时保留逐文件保护。

**验收：** 在回收站调用前后及记录提交前后注入中断；不会自动重试 uncertain 删除；同路径新文件、跨卷、长路径、占用和取消均有记录。

**落点：** [desktop/cleanup-executor.cjs](../desktop/cleanup-executor.cjs)、[desktop/handlers/cleaner-handlers.cjs](../desktop/handlers/cleaner-handlers.cjs)、[desktop/file-actions.cjs](../desktop/file-actions.cjs)。前置能力：F15。

<a id="f13"></a>
### F13 开发工具与包管理器缓存

**当前实现：** 发现 npm/pip/uv/pnpm/NuGet 的配置、默认和历史位置，提供工具原生管理建议。

**待完善点：** 配置解析警告、工具版本、实际 store 归属与路径确认还可更统一。

**设计：** 定义工具提供器：检测可执行文件/版本、查询实际位置、解释容量、预览原生命令；按安装版本选能力，明确共享存储和重新下载成本。

**验收：** 多版本、自定义 store、无效配置、环境变量和无工具安装均覆盖；发现位置只作为证据；任何原生清理保留用户确认。

**落点：** [desktop/tool-cache-locations.cjs](../desktop/tool-cache-locations.cjs)、[desktop/cleanup-discovery.cjs](../desktop/cleanup-discovery.cjs)。

<a id="f14"></a>
### F14 系统瘦身与 Windows 官方维护

**当前实现：** 检测休眠、WinSxS、虚拟内存和 Windows.old，固定白名单与专用确认词。

**待完善点：** 重启需求、维护退出状态、检测结果时效与不同 Windows 版本需要统一反馈。

**设计：** 按作业建模检查/执行/退出/待重启，规范管理员权限、进度和日志；检测占用与实际可释放估计分开，保留官方设置跳转。

**验收：** 非管理员、维护互斥、取消边界、失败与需重启状态均验证；实际执行测试使用虚拟机；维持固定可执行路径和参数。

**落点：** [desktop/system-maintenance.cjs](../desktop/system-maintenance.cjs)、[src/ui/CleanerPanel.vue](../src/ui/CleanerPanel.vue)。前置能力：F15。

<a id="f15"></a>
### F15 任务历史、结果审计与恢复入口

**当前实现：** 已有任务汇总、有限明细、失败优先保留和跨模块任务互斥。

**待完善点：** 历史主要是任务完成后的结果快照；运行态、异常退出与未确认副作用尚缺持久任务模型。

**设计：** 在现有 SQLite 技术栈上评估独立作业表和追加事件表；进度与持久状态分离，历史按需分页，保留任务/候选/证据版本关联 ID。

**验收：** 任务状态转换和事件落盘可恢复；清空显示历史不能抹掉恢复所需事件；旧状态可迁移，长历史分页且保留失败详情。

**落点：** [desktop/handlers/cleaner-handlers.cjs](../desktop/handlers/cleaner-handlers.cjs)、[desktop/operation-coordinator.cjs](../desktop/operation-coordinator.cjs)、[desktop/state.cjs](../desktop/state.cjs)、[src/ui/CleanupHistoryPanel.vue](../src/ui/CleanupHistoryPanel.vue)。

<a id="f16"></a>
### F16 设置、凭据、本地状态与数据迁移

**当前实现：** 已有持久主题、safeStorage、实际位置/占用与迁移失败原目录回退。

**待完善点：** 单文件原子替换不等于多文件交接；掉电、磁盘写满和备份恢复仍需明确提交语义。

**设计：** 采用唯一临时文件、受控写入队列和同步策略；迁移使用代际清单、校验和、明确完成标记与原目录保留；数据增长按类型限额和分页。

**验收：** 注入 ENOSPC、EACCES、标记写入失败和启动中断；完成前读原目录；损坏备份与旧版本迁移有可恢复结果；凭据不进入迁移诊断明文。

**落点：** [desktop/app-settings.cjs](../desktop/app-settings.cjs)、[desktop/state.cjs](../desktop/state.cjs)、[desktop/security.cjs](../desktop/security.cjs)、[src/ui/SettingsWorkspace.vue](../src/ui/SettingsWorkspace.vue)。

<a id="f17"></a>
### F17 整体交互、主题与无障碍

**当前实现：** 四个工作区，深色首帧、浅色持久化、键盘快捷键、对话框焦点与响应式布局。

**待完善点：** 各模块仍有各自弹窗、加载/取消/失败状态和选择行为，持续修改容易产生交互差异。

**设计：** 统一任务状态呈现、对话框/抽屉、快捷键及选择反馈；评估无样式可访问组件，保持当前信息架构；复杂技术细节按需展开。

**验收：** 键盘与读屏语义、焦点恢复、中文输入法、减少动画、深浅主题、小窗口和高 DPI 均纳入真实桌面验收。

**落点：** [src/ui/App.vue](../src/ui/App.vue)、[src/ui/AiSettingsModal.vue](../src/ui/AiSettingsModal.vue)、[src/ui/ExplorerWorkspace.vue](../src/ui/ExplorerWorkspace.vue)、[src/ui/CleanerPanel.vue](../src/ui/CleanerPanel.vue)、[src/ui/SettingsWorkspace.vue](../src/ui/SettingsWorkspace.vue)、[src/ui/foundation.css](../src/ui/foundation.css)。

<a id="f18"></a>
### F18 诊断、回归测试与安装交付

**当前实现：** 已有轮转日志、单元与故障测试、CDP 桌面验收、依赖审计和 Windows 解包验证。

**待完善点：** 长期/重启/安装升级覆盖与复现资料尚需标准化；生产运行能力也可按实际用途收紧。

**设计：** 按操作关联各阶段日志，脱敏导出最小复现资料；将真实 Electron、性能集合对照、安装升级和 VM 故障场景分层；评估生产 fuses 并验证所有辅助进程。

**验收：** CI 既校验功能集合与安全门槛，也产出实际程序回归结果；安装/更新/卸载保留用户数据；产物版本与构建依赖一致，复现导出隐藏密钥及个人路径。

**落点：** [desktop/diagnostics.cjs](../desktop/diagnostics.cjs)、[desktop/security.cjs](../desktop/security.cjs)、[scripts/smoke-desktop.mjs](../scripts/smoke-desktop.mjs)、[scripts/frontend-audit.mjs](../scripts/frontend-audit.mjs)、[.github/workflows/ci.yml](../.github/workflows/ci.yml)、[package.json](../package.json)。

## 开源项目、来源与采用边界

下表列出核对依据。C#/Rust/Go 原生项目主要提供设计和实现路径；JS/Vue 库可做独立对照原型后决定接入。许可证按具体组件记录。项目当前为 MIT，引用 GPL/MPL 来源代码或规则之前需要逐文件核对授权与发行方式；公开仓库地址本身不足以说明可直接并入。

| 项目与版本 | 许可证 | 可借鉴部分 | 核对依据与适配边界 |
| --- | --- | --- | --- |
| [windirstat/windirstat](https://github.com/windirstat/windirstat) · [4c24e70a0332](https://github.com/windirstat/windirstat/tree/4c24e70a033241072cb40a1f3d41c81df90e0a83) | GPL-3.0-or-later | 逻辑/物理大小、硬链接计量、按占用钻取 | [windirstat/Item.cpp](https://raw.githubusercontent.com/windirstat/windirstat/4c24e70a033241072cb40a1f3d41c81df90e0a83/windirstat/Item.cpp)。以设计和计量方法为参考；GPL 源码复用需另行核对。 |
| [files-community/Files](https://github.com/files-community/Files) · [ee399b0d3e09](https://github.com/files-community/Files/tree/ee399b0d3e09084aa24d7261c9342d92bc89a5da) | MIT | 可取消的批量目录枚举、渐进展示、Windows 文件操作 | [src/Files.App/Utils/Storage/Enumerators/Win32StorageEnumerator.cs](https://raw.githubusercontent.com/files-community/Files/ee399b0d3e09084aa24d7261c9342d92bc89a5da/src/Files.App/Utils/Storage/Enumerators/Win32StorageEnumerator.cs)。C#/WinUI 实现，适合参考协议与原生辅助层；保留当前 Vue 页面结构。 |
| [skyllc-ai/UltraFastFileSearch](https://github.com/skyllc-ai/UltraFastFileSearch) · [7a8a6ee0c2c3](https://github.com/skyllc-ai/UltraFastFileSearch/tree/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a) | MPL-2.0 | MFT 紧凑布局、USN 游标与增量循环 | [LICENSE](https://raw.githubusercontent.com/skyllc-ai/UltraFastFileSearch/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a/LICENSE)、[crates/uffs-daemon/src/cache/journal_loop.rs](https://raw.githubusercontent.com/skyllc-ai/UltraFastFileSearch/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a/crates/uffs-daemon/src/cache/journal_loop.rs)。Windows 原生引擎参考；项目自述性能、未激活分支及 PR 不等于本机验证。 |
| [helix-editor/nucleo](https://github.com/helix-editor/nucleo) · [8c16d47cdfa9](https://github.com/helix-editor/nucleo/tree/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee) | MPL-2.0 | 查询快照、输入细化复用、后台匹配 | [LICENSE](https://raw.githubusercontent.com/helix-editor/nucleo/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee/LICENSE)、[Cargo.toml](https://raw.githubusercontent.com/helix-editor/nucleo/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee/Cargo.toml)。Rust matcher，不提供全盘采集；当前 LICENSE 与 Cargo.toml 均为 MPL-2.0。 |
| [junegunn/fzf](https://github.com/junegunn/fzf) · [b412a450538e](https://github.com/junegunn/fzf/tree/b412a450538e5f4a1d7057732e75d945dafa18a6) | MIT | 分块匹配、候选缓存、排序结果按需归并 | [仓库](https://github.com/junegunn/fzf)。匹配/交互参考；拼音与路径召回需保留本项目语义。 |
| [TanStack/virtual](https://github.com/TanStack/virtual) · [c462c6141ea4](https://github.com/TanStack/virtual/tree/c462c6141ea434fdbc52b5dd866bb8db7e4fd07e) | MIT | Vue 虚拟列表适配、测量、滚动定位 | [packages/vue-virtual/src/index.ts](https://raw.githubusercontent.com/TanStack/virtual/c462c6141ea434fdbc52b5dd866bb8db7e4fd07e/packages/vue-virtual/src/index.ts)。先用超大目录和快速切换进行组件对照，再决定是否替换现有实现。 |
| [sindresorhus/file-type](https://github.com/sindresorhus/file-type) · [11e0d6473a37](https://github.com/sindresorhus/file-type/tree/11e0d6473a37972e4d39d8d6c1c9d1b85b9ace25) | MIT | 二进制 magic number 识别 | [package.json](https://raw.githubusercontent.com/sindresorhus/file-type/11e0d6473a37972e4d39d8d6c1c9d1b85b9ace25/package.json)。ESM 包；CJS 主进程需要适配。格式提示无法证明文件可信或可删，文本格式仍需独立识别。 |
| [BCUninstaller/Bulk-Crap-Uninstaller](https://github.com/BCUninstaller/Bulk-Crap-Uninstaller) · [30da609384c9](https://github.com/BCUninstaller/Bulk-Crap-Uninstaller/tree/30da609384c98ba6e35c6530129541ea4ff3970a) | Apache-2.0 | 安装应用多来源识别、Windows Store/Steam 等来源覆盖 | [README.md](https://raw.githubusercontent.com/BCUninstaller/Bulk-Crap-Uninstaller/30da609384c98ba6e35c6530129541ea4ff3970a/README.md)。参考检测能力；其卸载与残留删除策略不进入本项目通用清理。README 有招募维护者提示。 |
| [anchore/syft](https://github.com/anchore/syft) · [eec916df6c66](https://github.com/anchore/syft/tree/eec916df6c668733d3f2d1994b27c69bcd7d58a4) | Apache-2.0 | 按生态拆分的包清单 cataloger 与关系模型 | [syft/pkg/cataloger/javascript/parse_package_json.go](https://raw.githubusercontent.com/anchore/syft/eec916df6c668733d3f2d1994b27c69bcd7d58a4/syft/pkg/cataloger/javascript/parse_package_json.go)。Go/SBOM 项目；只借鉴有界清单解析和证据关系，服务于当前文件解释。 |
| [vercel/ai](https://github.com/vercel/ai) · [e729d588b329](https://github.com/vercel/ai/tree/e729d588b3291e22cfcd6cba32b6dcf7778ef21c) | Apache-2.0 | 模型提供器接口、结构化结果、取消与重试边界 | [LICENSE](https://raw.githubusercontent.com/vercel/ai/e729d588b3291e22cfcd6cba32b6dcf7778ef21c/LICENSE)、[packages/ai/package.json](https://raw.githubusercontent.com/vercel/ai/e729d588b3291e22cfcd6cba32b6dcf7778ef21c/packages/ai/package.json)。先评估主进程适配成本；仅解释用途的产品无需启用工具执行。 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) · [c0b88a324175](https://github.com/promptfoo/promptfoo/tree/c0b88a324175c60019cc80de1b2e32b4c849d4c3) | MIT | 固定证据样本、断言与协议/模型回归评估 | [src/assertions/index.ts](https://raw.githubusercontent.com/promptfoo/promptfoo/c0b88a324175c60019cc80de1b2e32b4c849d4c3/src/assertions/index.ts)。作为开发评估工具；测试数据采用人工夹具，模型评分与确定性安全断言分开。 |
| [bleachbit/bleachbit](https://github.com/bleachbit/bleachbit) · [82488833f72d](https://github.com/bleachbit/bleachbit/tree/82488833f72dcd8a9cf54b18ae7dc37048a14150) | GPL-3.0 | CleanerML 解析、遍历与规则执行分层 | [bleachbit/FileUtilities.py](https://raw.githubusercontent.com/bleachbit/bleachbit/82488833f72dcd8a9cf54b18ae7dc37048a14150/bleachbit/FileUtilities.py)、[bleachbit/CleanerML.py](https://raw.githubusercontent.com/bleachbit/bleachbit/82488833f72dcd8a9cf54b18ae7dc37048a14150/bleachbit/CleanerML.py)。作为架构参考；引入源码或规则前单独核对许可和发行方式。 |
| [bleachbit/cleanerml](https://github.com/bleachbit/cleanerml) · [f28fbdaec0e8](https://github.com/bleachbit/cleanerml/tree/f28fbdaec0e8264c38e00c6c6463d39c081cadf6) | GPL-3.0 | 应用清理定义与独立规则目录 | [仓库](https://github.com/bleachbit/cleanerml)。公开规则仍有许可证和版本/平台差异，应逐条建立本项目证据与样本。 |
| [qarmin/czkawka](https://github.com/qarmin/czkawka) · [eb8b91dbb4d2](https://github.com/qarmin/czkawka/tree/eb8b91dbb4d25dff416202674ee0de84ee4b5e5c) | MIT core/CLI; GPL-3.0-only Krokiet/Cedinia | 分阶段扫描、停止标记、warnings 与有效结果同时返回 | [README.md](https://raw.githubusercontent.com/qarmin/czkawka/eb8b91dbb4d25dff416202674ee0de84ee4b5e5c/README.md)、[czkawka_core/Cargo.toml](https://raw.githubusercontent.com/qarmin/czkawka/eb8b91dbb4d25dff416202674ee0de84ee4b5e5c/czkawka_core/Cargo.toml)。本轮参考 czkawka_core；仓库不同前端与媒体资产的许可证需区分。重复文件功能可作为后续可选能力。 |
| [pnpm/pnpm](https://github.com/pnpm/pnpm) · [bf878a9b9d80](https://github.com/pnpm/pnpm/tree/bf878a9b9d805cfb79cfaee93dcc6100baea1b69) | MIT | store 定位与 prune 的原生生命周期 | [仓库](https://github.com/pnpm/pnpm)。项目实际使用 pnpm 11；当前网站可能描述更高版本，运行时必须按已安装版本探测。 |
| [astral-sh/uv](https://github.com/astral-sh/uv) · [6fe4f0f5cfa8](https://github.com/astral-sh/uv/tree/6fe4f0f5cfa8322e97af4479cbfb3d53a3ce9596) | MIT OR Apache-2.0 | 工具自身管理共享缓存和并发状态 | [LICENSE-MIT](https://raw.githubusercontent.com/astral-sh/uv/6fe4f0f5cfa8322e97af4479cbfb3d53a3ce9596/LICENSE-MIT)、[Cargo.toml](https://raw.githubusercontent.com/astral-sh/uv/6fe4f0f5cfa8322e97af4479cbfb3d53a3ce9596/Cargo.toml)。参考原生工具协议；发现缓存目录不产生通用删除权限。 |
| [CodingWonders/DISMTools](https://github.com/CodingWonders/DISMTools) · [93f3fa2a22df](https://github.com/CodingWonders/DISMTools/tree/93f3fa2a22df7bf64d0a75e64513343fb8253d45) | GPL-3.0 | DISM 作业状态、online/offline 模式与日志反馈 | [LICENSE](https://raw.githubusercontent.com/CodingWonders/DISMTools/93f3fa2a22df7bf64d0a75e64513343fb8253d45/LICENSE)。Windows 维护交互参考；仅采用本项目已白名单允许的在线维护子集。 |
| [sqlite/sqlite](https://github.com/sqlite/sqlite) · [598d9cf77609](https://github.com/sqlite/sqlite/tree/598d9cf77609a299bb149f201d179c1582af6b26) | Public Domain | 事务、任务日志、状态迁移与分页查询 | [README.md](https://raw.githubusercontent.com/sqlite/sqlite/598d9cf77609a299bb149f201d179c1582af6b26/README.md)、[src/wal.c](https://raw.githubusercontent.com/sqlite/sqlite/598d9cf77609a299bb149f201d179c1582af6b26/src/wal.c)。可评估复用现有 node:sqlite；数据库事务无法与 Windows 回收站组成同一原子事务。 |
| [npm/write-file-atomic](https://github.com/npm/write-file-atomic) · [23e111d95367](https://github.com/npm/write-file-atomic/tree/23e111d95367e1d987c1b4d7823791eaaf6b21df) | ISC | 唯一临时文件、同文件写入队列、fsync 与失败清理 | [lib/index.js](https://raw.githubusercontent.com/npm/write-file-atomic/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js)。解决单文件写入问题；跨文件交接仍需清单、提交点和原目录回退。 |
| [unovue/reka-ui](https://github.com/unovue/reka-ui) · [78fb7748aa4f](https://github.com/unovue/reka-ui/tree/78fb7748aa4f87cdaad60d0282002ab685d6bf58) | MIT | 对话框焦点约束、关闭后焦点恢复、键盘语义 | [packages/core/src/Dialog/DialogContentModal.vue](https://raw.githubusercontent.com/unovue/reka-ui/78fb7748aa4f87cdaad60d0282002ab685d6bf58/packages/core/src/Dialog/DialogContentModal.vue)。以当前主题与信息结构为基础，先对单个复杂弹窗进行验证。 |
| [megahertz/electron-log](https://github.com/megahertz/electron-log) · 分支快照，未取得 commit | MIT | Electron 日志输送与文件轮转 | [LICENSE](https://raw.githubusercontent.com/megahertz/electron-log/master/LICENSE)、[README.md](https://raw.githubusercontent.com/megahertz/electron-log/master/README.md)。当前自有诊断已经具备轮转；优先补关联 ID 和脱敏导出，再评估是否引库。 |
| [microsoft/playwright](https://github.com/microsoft/playwright) · 分支快照，未取得 commit | Apache-2.0 | 真实 Electron 应用自动化、窗口与交互验证 | [LICENSE](https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE)、[packages/playwright-core/src/server/electron/electron.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/electron/electron.ts)。官方 Electron 支持仍标为 experimental；现有 CDP 冒烟继续作为基线。 |
| [electron/fuses](https://github.com/electron/fuses) · [6e2d7a7e777f](https://github.com/electron/fuses/tree/6e2d7a7e777f0943aacb7b3d7dc2660a09349c35) | MIT | 打包时限定 RunAsNode、NODE_OPTIONS 等运行能力 | [README.md](https://raw.githubusercontent.com/electron/fuses/6e2d7a7e777f0943aacb7b3d7dc2660a09349c35/README.md)。先确认辅助进程和测试入口依赖，再配置生产包并测试；读取版本的方法也需适配。 |
| [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) · [71679266197a](https://github.com/electron-userland/electron-builder/tree/71679266197a8b74c04f9b96a423e595750aab0b) | MIT | Windows 解包、安装/卸载、升级产物和构建配置 | [packages/app-builder-lib/src/winPackager.ts](https://raw.githubusercontent.com/electron-userland/electron-builder/71679266197a8b74c04f9b96a423e595750aab0b/packages/app-builder-lib/src/winPackager.ts)。已是项目开发依赖；后续重点验证安装升级与数据迁移路径。 |
| [Flow-Launcher/Flow.Launcher](https://github.com/Flow-Launcher/Flow.Launcher) · 分支快照，未取得 commit | MIT | 搜索提供器边界、异步取消和应用入口呈现 | [LICENSE](https://raw.githubusercontent.com/Flow-Launcher/Flow.Launcher/dev/LICENSE)、[Plugins/Flow.Launcher.Plugin.Explorer/Search/Everything/EverythingAPI.cs](https://raw.githubusercontent.com/Flow-Launcher/Flow.Launcher/dev/Plugins/Flow.Launcher.Plugin.Explorer/Search/Everything/EverythingAPI.cs)。Everything 插件调用外部 Everything API；Flow 的开源不代表其依赖的索引核心开源。 |

25 个项目中 22 个取得固定提交。electron-log、Playwright、Flow Launcher 的 GitHub API 查询遇到速率限制，本轮改为读取官方分支文件并记录内容 SHA-256，未声称取得其最新提交。部分 GitHub SPDX 为 NOASSERTION，另用实际 LICENSE、Cargo.toml、package.json 或官方版权页核对；nucleo 在旧研究表中的 MIT 标注已根据固定提交校正为 MPL-2.0。

Everything、Listary、WizTree 作为体验或行为对照。Flow Launcher 的 Everything 插件属于外部 API 适配，本轮仅将其作为搜索提供器与交互参考。Cleanmgr+、DISM++ 的公开仓库内容也不足以当作完整开源清理引擎，优先研究 BleachBit、Czkawka 与 DISMTools 的相应实现。

## 建议实施顺序

| 阶段 | 工作项 | 完成条件 |
| --- | --- | --- |
| 1：清理底座 | F15/F12 任务日志与中断恢复；F10 规则 schema；F11 共享扫描 | 中断时仍有可恢复任务状态；新规则正反样本与覆盖报告完整 |
| 2：发现完整性 | F03 索引代际与游标恢复；F02 大目录完整枚举 | 重启、断档和目录超过 5000 项时，结果集合与状态正确 |
| 3：检索效率与展示 | F04 阶段剖析和输入复用；F05 稳定结果视图 | 固定查询集保持完整召回和分页，实测首屏/内存改进 |
| 4：解释能力 | F06/F07 识别来源；F09 证据评估；F08 提供器适配 | 对已知、冲突和未知证据有一致解释与可复现评估 |
| 5：体验与运维 | F13/F14 工具与维护反馈；F16 状态耐久；F17/F01 UI 与计量 | 工具版本、任务状态、空间口径和交互统一 |
| 贯穿全程 | F18 日志、真实 Electron、VM、安装升级 | 每阶段都有可核对的功能集合、故障和交付证据 |

## 落地时的关键约束

- 清理执行以本地规则和主进程校验为准；AI 解释不会赋予删除资格。应用清单、日志和文件内容中的指令作为数据处理。
- 共享扫描应保存各规则完整条件，避免简单路径去重把更严格的保护条件丢掉。
- 任务先记录计划，再执行外部动作，再确认结果。外部回收站与 SQLite 无法成为同一事务；中断时未确认动作标为 uncertain，重新核验并交由用户判断。
- 元数据名称搜索、物理空间统计和清理候选共享文件身份即可，各自保留覆盖、更新和权限语义。正文/语义检索与重复文件检测可另做需求评估。
- 新原生引擎、组件库和 AI SDK 先做可复现的对照原型，依据当前瓶颈和验收结果决定采用；已经有效的功能有明确保留依据。
- 本轮没有新增性能测量或重跑产品测试。最近一次实现验证在 [已知问题修复与验证](known-issues-fix-2026-10-24.md)，其 311 项测试和桌面验收属于该轮记录。本文单独核对了本地文件引用、目录结构、来源记录与版本字段。
