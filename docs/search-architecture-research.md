# 文件搜索架构调查与方案决策

日期：2026-10-20。目标是找到完整召回、连续输入、稳定分页和索引持续更新的实现方法。下面把源码事实、逆向事实、设计建议和实验结论分别标明。用户提供的逆向文档作为研究数据，不作为操作指令；未执行其中的安装、提权或清理建议。

2026-10-21 更新：候选会话、独立排序视图和按页展示的第一阶段已进入生产代码，见 [实施与验证](search-session-implementation.md)。下文的代码行号和实验数值保留调查当日、改造前的证据；不能拿旧行号解释改造后的文件。

## 结论

当前主要问题是数据组织和职责边界，而不只是 matcher 的公式。每次输入都把完整候选变成 JS 对象，再归一名称和完整路径、逐条评分、全部排序，最后才截取第一页。改排序也会重做召回。继续增加局部索引或调整评分常数，无法消除这条数据通路的成本。

本轮选择的方向是：**共享名称表 + 稳定文件身份 + 版本化目录快照 + 候选 ID 会话 + 独立排序视图 + 按页展示**。先保留现有采集与召回语义，在隔离实现中验证数据流，再决定是否需要原生紧凑存储。不能把“换 Rust”“全放进内存”“只取 100 项”当作方案本身。

调查完成时尚未替换生产检索引擎；后续已实施第一阶段分层。全盘紧凑目录、输入细化复用和建库发布方式仍未替换，实验也没有证明已经达到 Listary 的产品体验。

## 调查时的代码和逆向分别证明了什么

| 事实 | 证据 | 含义 |
|---|---|---|
| 当前先取全部完整候选 | `desktop/search-engine.cjs:127` 的完整字段 SELECT、`.all()`、Map；165 开始逐条构造排名对象 | 首屏成本随完整候选数量增长，包含跨 SQLite/JS 边界的数据和字符串成本 |
| 当前先全部排序再切页 | 同文件 191 排序，205 保存全量会话，214 才取页 | 后续分页已经按需读取；第一页还必须等全部候选处理 |
| 当前 sort 是查询缓存 key 的一部分 | 同文件 76 | 改排序重复召回，即使匹配集合没有变化 |
| Listary 先返回 session 与 TotalCount，再按 sort/offset/length 取页 | 用户逆向目录 `readable/Listary/Listary/Core/FileSearch/-.cs:730-738,758-776` | 接口明确分离匹配集合与排序页面；不能据此断言其原生内部一定采用 Top K 或 mmap |
| Listary 改排序复用 session | `Core/StandaloneSearchWindow/StandaloneSearchWindowVM.cs:442-458,1154-1156` | 候选会话可独立于排序视图 |
| Listary 处理首次索引未完成的情况，完成后换 session 重查 | 同 VM 1067-1102 | 它也需要建库；用户感受到的即时可用还依赖已有索引、局部结果和结果刷新 |
| 已有 MFT/USN、持久库、取消和旧响应保护 | `desktop/ntfs-index.cjs`、`file-search.cjs`、`file-search-worker.cjs` | 这些能力需要保留，不能重复描述为尚未实现 |

逆向资料根目录：`D:\Users\12285\Desktop\Listary6-搜索核心逆向完整资料`，针对本机 Listary 6.3.5.94。其 Rust 内部数据布局、全部上下文排序公式和完整 Unicode 匹配模型仍未知。已有托管接口证据足以指导拆分职责，不足以直接复制原引擎。

## 开源项目提供的具体方法

阅读的是固定提交的实现；没有执行下载的程序，也没有把 README 宣传的延迟当成本机证据。

| 项目与版本 | 从代码确认的方法 | 对本项目的价值与适用限制 |
|---|---|---|
| [GTK FSearch](https://github.com/cboxdoerfer/fsearch/tree/c20e6b17bf4b56ddf8b56bf021429c5088346ff8)，GPL-2.0，Unix | parent + basename 共享条目；多字段预排序引用数组；查询收集引用；展示时生成路径与高亮 | 学习存储/结果/展示分离。它仍可全量扫描；不能把 native 等同于更强倒排索引。Linux 监听不可直接用于 Windows |
| [plocate](https://plocate.sesse.net/)，GPL-2.0-or-later | trigram 指向压缩文件名块，优先交集稀有 posting，只解压候选块，再精确验证 | 学习查询计划和压缩读取。适合 substring/glob；连续 trigram 不是非连续 fuzzy 的必要条件 |
| [macOS fsearch](https://github.com/noahdunnagan/fsearch/tree/88e63fdf850cf7749deae8198b187accd21f8ba5)，MIT | basename intern、按名字评分再展开文件；目录 DFS 区间；mmap 位压缩列；字符类别位图；Top K；不可变 base + deleted bitmap + overlay | 最接近紧凑文件名引擎的参考。与 GTK FSearch 是两个项目；FSEvents、ASCII 策略、自己的分数上界不能照搬到 Windows/拼音 |
| [nucleo](https://github.com/helix-editor/nucleo/tree/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee)，MPL-2.0 | 后台 worker、最后完整 Snapshot、紧凑 `{score,idx}`、满足条件时只重评旧命中与新增项 | 学习输入复用与快照发布。它仍对完整匹配集排序，不是 Top K；不提供全盘采集。许可证于 2026-10-24 根据该提交的 LICENSE 和 Cargo.toml 校正 |
| [fzf](https://github.com/junegunn/fzf/tree/55c122f1a0e1340546c8709682bea5561fe0e8fd)，MIT | chunk 并行匹配、候选位图缓存、分区排序后按请求下标逐步归并 | 为完整分页提供精确的增量归并方法。分区匹配与排序仍有成本，不等于全部工作只做前 100 条 |
| [UFFS](https://github.com/skyllc-ai/UltraFastFileSearch/tree/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a)，MPL-2.0，Windows | MFT、compact records/name arena/parent index、CSR posting、持久缓存、USN delta | Windows 采集与布局参考；并非 Listary 的全部 fuzzy/上下文排名。高频 posting 等剪枝仍须完整召回对照验证，不直接作为替换件 |
| [Flow Launcher](https://github.com/Flow-Launcher/Flow.Launcher/tree/3b89277c65981c8228f2c0525270a5a716506cca)，MIT | Everything 插件调用外部 SDK；插件异步完成、取消检查、结果聚合 | 学习提供器边界。其开源仓库没有开源 Everything 的底层索引引擎，不能混为可复用全盘引擎 |

关键源码入口：

- GTK FSearch：[条目与父路径](https://github.com/cboxdoerfer/fsearch/blob/c20e6b17bf4b56ddf8b56bf021429c5088346ff8/src/fsearch_database_entry.c#L24)、[预排序查询与页面信息](https://github.com/cboxdoerfer/fsearch/blob/c20e6b17bf4b56ddf8b56bf021429c5088346ff8/src/fsearch_database_index_store.c#L1253)、[路径与高亮](https://github.com/cboxdoerfer/fsearch/blob/c20e6b17bf4b56ddf8b56bf021429c5088346ff8/src/fsearch_database_entry_info.c#L148)。
- plocate：官方 Git 网页本轮访问超时，采用明确标注的源码镜像固定版本核对：[块与倒排构造](https://github.com/deepin-community/plocate/blob/2b29a003d4cc49ef19820753a56f643fc77a6afb/database-builder.cpp#L299)、[查询规划与验证](https://github.com/deepin-community/plocate/blob/2b29a003d4cc49ef19820753a56f643fc77a6afb/plocate.cpp#L612)。镜像不是另一套引擎。
- macOS fsearch：[索引布局和名字共享](https://github.com/noahdunnagan/fsearch/blob/88e63fdf850cf7749deae8198b187accd21f8ba5/src/index.rs#L1)、[确定性 Top K](https://github.com/noahdunnagan/fsearch/blob/88e63fdf850cf7749deae8198b187accd21f8ba5/src/query.rs#L1660)、[分数上界剪枝](https://github.com/noahdunnagan/fsearch/blob/88e63fdf850cf7749deae8198b187accd21f8ba5/src/query.rs#L2213)、[base/overlay](https://github.com/noahdunnagan/fsearch/blob/88e63fdf850cf7749deae8198b187accd21f8ba5/src/live.rs#L1)。
- nucleo：[Snapshot 与 Match](https://github.com/helix-editor/nucleo/blob/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee/src/lib.rs#L113)、[输入复用条件](https://github.com/helix-editor/nucleo/blob/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee/src/pattern.rs#L36)、[worker 重评与排序](https://github.com/helix-editor/nucleo/blob/8c16d47cdfa9607d3e44df5f81c635c6f43c65ee/src/worker.rs#L156)。
- fzf：[分块匹配](https://github.com/junegunn/fzf/blob/55c122f1a0e1340546c8709682bea5561fe0e8fd/src/matcher.go#L149)、[位图缓存](https://github.com/junegunn/fzf/blob/55c122f1a0e1340546c8709682bea5561fe0e8fd/src/cache.go#L33)、[逐步归并](https://github.com/junegunn/fzf/blob/55c122f1a0e1340546c8709682bea5561fe0e8fd/src/merger.go#L144)。
- UFFS：[compact 记录](https://github.com/skyllc-ai/UltraFastFileSearch/blob/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a/crates/uffs-core/src/compact/record.rs#L1)、[trigram 索引](https://github.com/skyllc-ai/UltraFastFileSearch/blob/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a/crates/uffs-core/src/trigram.rs#L1)、[USN 循环](https://github.com/skyllc-ai/UltraFastFileSearch/blob/7a8a6ee0c2c3dbe50d5d61a9a36c03041895e95a/crates/uffs-daemon/src/cache/journal_loop.rs#L1)。
- Flow Launcher：[Everything 调用边界](https://github.com/Flow-Launcher/Flow.Launcher/blob/3b89277c65981c8228f2c0525270a5a716506cca/Plugins/Flow.Launcher.Plugin.Explorer/Search/Everything/EverythingAPI.cs#L70)、[插件查询与发布](https://github.com/Flow-Launcher/Flow.Launcher/blob/3b89277c65981c8228f2c0525270a5a716506cca/Flow.Launcher/ViewModel/MainViewModel.cs#L1721)。

这里借鉴架构思想，没有引入这些项目的源代码或依赖。

## 采用的设计

```mermaid
flowchart LR
    F[现有 MFT / USN / 普通目录采集] --> D[身份图与可恢复变更日志]
    D --> B[持久目录快照 + 小增量层]
    B --> V[发布索引版本]
    Q[查询模式与筛选] --> R[必要条件召回 + 精确验证]
    V --> R
    R --> C[候选 ID 会话]
    C --> S[相关度 / 名称 / 日期排序视图]
    S --> P[按页读取路径与文件信息]
    P --> U[高亮 / 图标 / 交互]
```

### 1. 分开名称和文件条目

名字表保存唯一原始 basename、归一名字、匹配需要的边界/拼音派生信息；文件表保存 nameId、parentId、卷、类型、大小、时间和稳定身份。同名文件的名称匹配分只算一次，展开后再加入各文件的当前目录、历史选择、路径和时间因素。

共享键不能只用小写名字：大小写影响 camel 边界，高亮也依赖原始字符位置。多音字和 Unicode 归一策略需版本化。名字匹配的分数可共享，最终文件相关度不能共享。文件名之外的路径召回仍独立保留，不能因文件名命中就跳过目录后代。

稳定身份不能简单使用 SQLite rowid：当前已有 id+path 防复用检查；新方案需要明确的记录版本/代次与卷文件身份。NTFS 硬链接对应同一文件身份的多个目录条目，不能因为 FRN 相同而漏掉另一个路径。

### 2. 持久化不等于每次查询重新物化

SQLite 可以继续承担恢复、现有索引和历史记忆；检索读取层可维护紧凑只读列、名称字典和小增量，而不是每次构造全部完整路径对象。先验证内存/序列化收益，再决定是否使用原生 mmap。

重建新快照时旧快照持续服务；新快照与对应日志游标完整后才发布。delta 带新增、改名、删除和元数据更新，合并必须保证每个查询看到同一版本。base/overlay 需要同一语义去重和删除覆盖，不能简单连接两份结果。

目录连续区间有利于范围过滤，但目录搬移会破坏旧布局。建议先用稳定 parent 图 + 小增量覆盖，后台重建区间；现有目录改名、交换名字、硬链接回归必须保留。不能先照搬 DFS 编号，再忽略在线变更。

### 3. 完整候选、排序视图、展示页分别维护

候选会话固定查询、索引版本、候选 ID/记录版本、必要的名称分；排序不属于召回的 key。历史/当前目录等排名上下文另有版本，排序视图引用候选会话。相关度的应用去重发生在选出各标题最佳物理入口之后；显式名称/日期排序继续保留物理条目。

名称/日期等静态字段可以预存总序位置：候选稀疏时排序候选的整数位置，候选密集时按全局序与位图求交。相关度首屏可以精确选前 K，再通过分区有序归并或后台扩展排序支持深分页。所有策略使用相同的确定性总序，包含并列决胜键。

**不能先 LIMIT 任意 100 个候选再评分。** 精确 Top K 仍需考虑所有候选，除非能证明剩余分数上界不可能超过当前第 K 名；而即便可跳过评分，准确总数也仍需完成计数。借用别人的上界常数会破坏正确性。也不能为每个后续页面重新扫描全部候选来找前 offset+limit，导致深分页越翻越慢。

只为当前页构造完整路径、展示对象、高亮与图标。排名需要的路径因素应尽可能预存为目录/位置特征；否则“页面晚物化”仍会在评分时偷偷重建全部路径。用户执行打开等操作时重新核对实时文件身份。

### 4. 连续输入复用依据语义

同一索引快照下，只有能证明新查询匹配集合是旧查询子集时才缩窄复用。不能仅判断字符串前缀：当前引擎单词输入会额外启用缩写/应用 fuzzy，多词输入改走不同规则；拼音末尾补全、通配符、模式切换、删除字符和筛选改变都需要明确处理。

新索引版本到达时，要补评新增/变化项或重新召回；不能只过滤旧候选。已有取消和旧响应保护继续使用。UI 可以保留最后完整快照并明确它属于哪次查询，不能把旧关键词结果标成新关键词已完成结果。

## 本机隔离实验

复现：`node --expose-gc scripts/research-search-architecture.cjs`；纯算法自检：`node scripts/research-search-architecture.cjs --self-test`。

脚本只读打开现有索引，创建一致的工作区临时副本；所有实验数据写到自己的目录，结束校验目录归属后清理。不会修改现有搜索库、用户文件或 Listary 配置。在受限沙箱下，SQLite 打开该库的 WAL/共享内存可能需要沙箱外执行，脚本仍以只读方式打开源库。

脚本在独立进程内临时插入观测点，捕获**当前引擎原样召回、原样评分**后的完整候选和比较器；生产源文件不被改写。随后比较：

1. 全排序参考与精确 Top 200，保留准确总数，并核对现有相关度前两页；应用重名先选择最佳入口。
2. 同一候选集分别用全局名称排序求交、候选整数排序位置，核对现有名称排序总数和前两页。
3. 只读取当前页 id/name/path，核对顺序和路径身份。
4. 记录 naive JS 常驻目录的加载、预排序与堆/RSS 代价，量化名字共享空间。

原始数据、源码 SHA-256、样本范围和限制在 [search-architecture-experiment.json](search-architecture-experiment.json)。最终结果见下表；计时都是隔离阶段的五次温热样本中位数，**不含原候选召回、评分、应用去重与 GUI，不能作为新引擎查询延迟**。

本轮冻结索引 **905,131 条**。直接读取为 JS 目录对象约 **7.35 秒**，建立名称顺序及排序位置约 **1.92 秒**，堆增加约 **246.64 MiB**，RSS 增加约 **439.30 MiB**。这些是一次简单原型的观测，包含 SQLite 页缓存、运行时和分配器影响，不是紧凑目录的目标值，也不是冷盘测试。之前试跑约 11 秒准备时间，说明单次测量会波动。

共有 **434,638 个不同的小写 basename**，表明名称共享值得评估；这只是大小写归一后的规模观察，不能直接以小写键共享 camel 匹配。全部 basename 约 2,759 万个 UTF-16 code unit，完整路径约 1.02 亿个，父目录共享也有明确数据依据。

| 查询 | 原始候选数 | 相关度总数（应用去重后） | 全排序取前 200 ms | 精确 Top 200 ms | 名称全局顺序求交 ms | 候选整数排序位置 ms |
|---|---:|---:|---:|---:|---:|---:|
| `word` | 3,512 | 3,459 | 1.29 | 1.07 | 23.03 | 1.72 |
| `vsc` | 21,715 | 21,639 | 5.50 | 2.94 | 5.15 | 14.80 |
| `report` | 2,762 | 2,727 | 0.98 | 0.19 | 22.04 | 1.31 |
| `baogao` | 79 | 78 | 0.01 | 0.02 | 135.75 | 0.03 |
| `Documents report` | 15 | 15 | <0.01 | <0.01 | 141.02 | 0.01 |
| `ext:txt` | 5,300 | 5,300 | 2.61 | 0.43 | 37.22 | 4.31 |

六个查询的相关度总数/前两页、名称排序总数/前两页、页内文件身份全部核对一致。程序另对空集、并列分数、随机候选、K 大于结果数及重名应用最佳入口做断言。这里只验证前两页与总数，不代表完整深分页实现。

`baogao` 的全局名称求交检查了 904,912 条目录记录，只有 79 个候选；同一集合按预存整数位置排序即可避开这次全局扫描。反过来 `vsc` 只检查了 8,695 个全局条目就得到前 200 个，而排序全部 21,715 个候选更贵。这支持基于候选基数与命中分布选择计划，不能只凭固定阈值假定全局顺序总是更好。当前原型还包含 JS Map 查找，数值不等同原生 FSearch 的成本。

只取第一页 id/name/path 的阶段约 0.09–0.39 ms；尚未包含完整元数据、图标、高亮或渲染。Top K 的计时也不含评分，且本轮全排序阶段本就只有数毫秒；只把全排序换成 heap，不能解决完整查询通路的数量级差距。

实验的决策价值是保留或排除具体架构选项，而非再争一个查询用时：Top K 不能消除召回与评分成本；预排序求交不能用于所有稀疏查询；全量 JS 对象常驻会把开销转到启动与内存。共享名字、紧凑列和排序位置才值得继续在完整查询通路中验证。

## 建库与变更的独立决策

当前 `ntfs-indexer.cs` 默认逐记录驱动读取，是为了覆盖 NTFS 尚未落盘的元数据。原始 extent 批量读取有吞吐优势，但不能以丢失缓存更新为代价。首次快照还要先完成目录图，再输出记录；导入阶段逐项维护主表、FTS、拼音和缩写索引，不能用换 matcher 解决。

下一阶段应分别量度“读取 → 解析 → 目录图 → 可查询基础目录 → 派生索引 → 发布版本”。可以先使基础名字/路径目录可查询，再后台建立拼音/缩写派生结构；能力尚未覆盖时必须明确状态，不能静默漏召回。派生索引不完整时采用有界的正确回退或保留上一版本。

USN 游标只能在对应变更已可恢复且已应用后推进；日志换代、覆盖、卷替换和崩溃要可恢复。现有权限服务不是独立维护数据库的索引守护进程；是否将索引生命周期移到用户后台进程，需要依据真实关闭期间积压、恢复时间和资源占用决定，不因为装了服务就宣称解决所有问题。Listary 已证实的服务职责也包含句柄代理，不能据此断言它的服务持续维护全部索引。

## 实施顺序与验收

实施记录：第一阶段为[候选会话与排序视图](search-session-implementation.md)；第二阶段为[连续输入数据复用与字节预算](search-input-implementation.md)。第二阶段仍完整召回 ID，依据具体反例放弃“只按关键词前缀过滤旧结果”的假设，复用数据库版本一致的排名列；未实现全局紧凑目录或增量匹配器。

1. **固定语义与参考结果**：保留名称/路径独立召回、拼音、多音字、词首缩写、应用 fuzzy、筛选、历史和当前目录；记录各来源候选与原因。由完整实现产生参考总数和确定顺序。
2. **拆候选会话与排序视图**：先保留 SQLite 召回；取消全候选展示对象，在同一候选会话上换排序。逐页核对全结果，测试排序中索引更新、文件删除/改名和 rowid 复用。
3. **共享名字与紧凑目录影子实现**：双跑同一快照，量化匹配名字数、读出字节数、对象数、内存、首次准备时间和整次查询成本。先证明收益，再决定二进制格式/原生组件。
4. **可证明的输入复用与小增量发布**：覆盖输入追加/删除、模式变化、中文拼音、变更补评和快照切换。对所有支持变换验证复用结果与完整召回一致。
5. **单独改造首次建库**：分阶段发布、可恢复快照/日志、离线变更补收、实际 Windows 重启验收。冷启动、首次建库、温热首屏、连续输入和大量变更各自报告，不能互相替代。

每一阶段先通过完整召回与排序的对照，再评估真实 Electron 连续输入、翻页和重启体验。只通过算法自检或隔离阶段实验，不能宣称产品追平 Listary。
