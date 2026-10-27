# 连续输入的数据复用与会话预算

2026-10-22。接续[候选会话与排序视图改造](search-session-implementation.md)，依据[架构调查](search-architecture-research.md)中的稳定快照、共享名字和语义复用原则实施。本轮保留完整召回，减少连续输入时重复读出排名数据的工作。

## 复用对象与语义边界

每个新关键词仍执行完整 ID 召回，包括名称、目录路径、拼音、应用 fuzzy 和普通文件缩写。之后以 ID 对照同一数据库版本、相同范围/类型/时间/当前目录条件的近期候选会话，只为新出现的 ID 读取名称、路径、大小、时间等排名列。旧候选中仍命中的列复制到新的紧凑数组，未使用的名字和父会话数组不会被新会话整体引用；共享的名称描述保留原始大小写。

新输入重新评分所有原始物理候选，并重新决定同名应用的最佳入口。候选排列采用本次召回顺序，不沿用上一关键词的排名或去重结果。追加字符、退格和模式切换均可使用这种数据复用，不需要假定新结果是旧结果的子集；关键词变化仍建立新的 session。排序切换继续复用同一 session 的候选。

不直接过滤旧匹配集合的两个回归例子：

- `ke` → `kel` 从短词 LIKE 切换到 trigram。SQLite 的大小写/Unicode 处理使 `Kelvin.txt` 可以在后一步才被召回；仅保留旧候选会漏掉它。
- `ace` → `aceg` 时，`AwesomeCodeEditorguide.exe` 和 `AwesomecodeEditorGuide.exe` 的最佳入口可以互换。仅复用去重后的旧结果会丢掉新的最佳入口。

数据复用默认开启，近期来源窗口为 15 秒。`incrementalReuse: false` 可关闭该路径用于对照；`cacheMs: 0` 关闭隐式同词结果缓存，不会把输入序列的对照误变成同词命中缓存。

## 版本与读取一致性

候选指纹包含应用修订号、`PRAGMA data_version`、`total_changes()` 及连接的事务状态。`data_version` 检测其他连接的提交，同连接写入另由累计修改数覆盖；其作用范围见 [SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version)。调用方处于外层事务时禁用隐式结果/候选数据复用，避免事务回滚后复用未提交数据。

一次新查询的 ID 和所缺排名列在同一 [SQLite SAVEPOINT](https://www.sqlite.org/lang_savepoint.html) 读取快照中取得。读取前后重新比较指纹；若复用了旧列而版本改变，丢弃该次结果并在不复用列的情况下重读一次。第二次的完整数据来自同一快照，即便随后又有外部提交，也不会混用两个版本的排名列。

显式旧 session 仍保留开始翻页时的顺序与文件身份，不因后台更新而中途重排；展示页继续核对实时 ID 和路径。实时删除可能令可见条目少于会话开始时的总数，这是已有快照分页行为。

## 按表示字节管理缓存

会话缓存默认最多 4 个会话、64 MiB 的保留数据估算预算。估算包括候选列、路径/名称文本、延迟建立的 ID 映射、排名列、排序分区、归并游标及随翻页增长的有序前缀；共享 ArrayBuffer 按整个底层缓冲区计量一次。静态文本大小在建会话时计算，页面读取不会逐个扫描所有路径以重新计费。

预算是缓存保留数据的估算，不是进程 RSS 硬上限：共享文本会保守重复计量，运行时、SQLite 和查询中的临时对象不在该值内。超预算时优先释放其他 LRU 会话；当前会话有多个排序视图时只保留当前视图。一个单独就超过预算的活跃会话允许保留，否则后续页会失去快照并重新从第一页开始。下个查询成为活跃会话后，旧的大查询可被淘汰。

生产入口为 `desktop/search-engine.cjs`、`desktop/search-candidate-session.cjs`、`desktop/search-result-view.cjs` 和新增的 `desktop/search-session-cache.cjs`。`profile('fetch')` 记录新读取的排名数据行数，`profile('reuse')` 记录复用行数，`cacheStats()` 提供预算状态；这些统计不代表全部数据库读取量。

## 当前验收

39 个测试文件、272 项测试通过，类型检查、生产构建和 40 个桌面模块语法检查通过。新增测试覆盖：

- 两个独立引擎启用/关闭复用后的全分页顺序、总数、身份和元数据对照；追加、退格、拼音、多词、末尾空格、通配符、模式切换和各类排序。
- Unicode 新增召回、应用最佳入口变化、范围/类型/时间/当前目录变化以及修订号变化。
- 另一连接提交、同连接写入、版本检查与读取快照之间的提交，以及外层事务回滚。
- 会话 LRU、共享缓冲区计费、视图增长、超预算活跃查询的完整翻页及排序切换。

真实 Electron 开发回归通过，新增连续输入 `page-rep → page-repo → page-rep` 的完整结果检查，原有拼音高亮、145 项全部翻页、排序回到首屏、同 session 排序、建库期间搜索、缩写和高亮更新均通过。汇总见 [search-input-integration.json](search-input-integration.json)。

另对 **930,372 条**真实索引的一致副本，运行 15 次输入变化。对照引擎与复用引擎各有独立连接，关闭同词结果缓存，交替执行先后，核对所有页面的有序身份、元数据摘要、总数及无重复，全部一致。脚本为 `scripts/verify-search-input.cjs`，原始记录与源码哈希见 [search-input-validation.json](search-input-validation.json)。示例工作量：

| 输入变化 | 本次原始候选 | 复用排名数据 | 新读取排名数据 |
|---|---:|---:|---:|
| `repo` → `repor` | 3,207 | 3,207 | 0 |
| `repor` → `report` | 3,146 | 3,146 | 0 |
| `report` → `repor` | 3,207 | 3,146 | 61 |
| `vs` → `vsc` | 21,995 | 21,995 | 0 |
| `vsco` → `vsc` | 21,995 | 19,890 | 2,105 |

“新读取为 0”仅指排名列：完整召回 SQL、缩写/拼音验证及当前页展示数据仍有读取。记录中的首 500 项耗时各只有一次诊断样本，有提速也有退化，不能据此作整体速度或 GUI 延迟结论；当前对照也不是与改造前旧引擎或 Listary 的性能对照。

## 仍需补充的缺口

每次输入仍执行完整 SQL/FTS 召回，复制候选列、重新评分并排序分区。当前是候选数据复用，没有跨输入复用匹配器状态，也没有持久化全局紧凑目录、父目录图或小增量覆盖层。宽泛查询的第一屏仍会受到这些阶段影响。

本轮未改造首次全盘入库、派生索引发布及离线大量变化补收，也未实际重启 Windows；这些应继续独立分阶段计量和验收。已有 MFT/USN、开机服务与分层会话是基础，不能据此宣称已经达到 Listary 的即时体验。

复现：

```powershell
node scripts/verify-search-input.cjs
node node_modules/vitest/vitest.mjs run --configLoader runner --maxWorkers=2 --testTimeout=15000
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node scripts/check-desktop.cjs
node node_modules/vite/bin/vite.js build --configLoader runner
$env:DISK_SENSE_SMOKE_VIEW = 'inspect'
$env:DISK_SENSE_SMOKE_INSPECT_SEARCH = '1'
$env:DISK_SENSE_SMOKE_SEARCH_QUERY = 'search-smoke'
$env:DISK_SENSE_SMOKE_SEARCH_EXPECTED = 'search-smoke.txt'
$env:DISK_SENSE_SMOKE_SEARCH_ADVANCED = '1'
node scripts/smoke-development.mjs
```
