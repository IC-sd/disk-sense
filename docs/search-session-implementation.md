# 候选会话与排序视图改造

2026-10-21。依据 [架构调查](search-architecture-research.md) 实施的第一阶段，保留现有 MFT/USN 和 SQLite 召回，改变召回之后的组织方式。参考了 fzf 的分区排序、按需归并思想；代码为本项目实现。

## 已实现的行为

- 一次完整召回建立候选会话，名称、修改时间、大小和相关度分别是该会话的排序视图。排序不再进入匹配条件的 key；同 session 切换排序不重跑 SQL/FTS 召回。
- 候选会话将 ID、大小、时间、标志、名称引用等保存为列数组，同一原始 basename 共享一个名称条目。共享键保留大小写，避免把 `VisualStudioCode` 与 `visualstudiocode` 的 camel 匹配混同。名称匹配分在一次相关度构建中复用，目录和历史因素仍按各文件计算。
- 名称/修改时间/大小视图跳过相关度评分。相关度视图先确定每个应用标题的最佳物理入口，再去重；显式字段排序保留全部物理条目，因此两类视图的总数可以不同。
- 每个视图先排序所有分区，再用最小堆只归并请求需要的有序前缀。后续页延续游标；已生成的重叠页面复用前缀，不重新扫描全部候选。不提前截断召回，没有为了首屏丢掉后面的匹配。
- 第一页与后续页统一按需读取完整文件记录，然后构造高亮和展示对象。旧会话仍按 ID 与归一路径核对实时文件，跳过删除或被其他路径复用的 rowid。
- 取消发生在增量归并中时丢弃该排序视图，保留完整候选和历史上下文；再次使用相同 session 可以重建确定的顺序。
- UI 切换排序清掉旧页、选择和滚动位置，从同一候选 session 的 offset 0 开始。关键词、范围、目录、类型、时间改变或主动刷新重新召回；旧分页响应不能覆盖新排序。

实现入口：`desktop/search-candidate-session.cjs`、`desktop/search-result-view.cjs`、`desktop/search-engine.cjs`、`src/ui/ExplorerWorkspace.vue`。

## 验证范围

测试覆盖分区排序与完整稳定排序逐页对照、并列键、空集、远页、重复页不增加归并工作、取消；集成测试覆盖切换排序只召回一次、不同视图的准确总数、三种字段排序全部分页、筛选使会话失效、索引更新/删除/rowid 复用，以及取消后的同会话恢复。

桌面回归增加真实 UI 的“145 条结果加载完 → 改名称排序回到首 100 条 → 再加载全部 145 条”，并通过真实 IPC 在同 session 下切换名称/时间/大小，核对总数、100+45 两页与全部路径唯一性。验证结果记录于 [search-session-validation.json](search-session-validation.json)。

2026-10-22 验收完成：36 个测试文件、247 项测试通过；类型检查、生产构建与 39 个桌面模块语法检查通过。真实 Electron 开发回归的拼音、缩写、高亮刷新、排序重置、排序会话复用、全部翻页和建库期间搜索均通过；截图为 `release/smoke-inspect.png`。更新后的正常用户配置窗口已启动并核验标题、响应状态及本工作区的 `desktop/main.cjs` 路径。

905,131 条一致索引副本的六类查询，原始候选数与相关度总数与改造前记录一致；当前前两页与完整排序对照一致。这不是保存了旧版全部顺序的逐项对照，也不是百万条索引的 GUI 延迟测量。

全量测试使用两个 worker、15 秒单项超时，断言没有改变；默认 5 秒运行曾在既有清理测试的系统进程查询上超时。开发烟测已改为等待导航及设置/历史界面实际就绪，保留所有断言；开发服务只以 `index.html` 为依赖扫描入口，监听排除研究与验收缓存。

复现命令：

```powershell
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/vitest/vitest.mjs run --configLoader runner --maxWorkers=2 --testTimeout=15000
node scripts/check-desktop.cjs
node node_modules/vite/bin/vite.js build --configLoader runner
$env:DISK_SENSE_SMOKE_VIEW = 'inspect'
$env:DISK_SENSE_SMOKE_INSPECT_SEARCH = '1'
$env:DISK_SENSE_SMOKE_SEARCH_ADVANCED = '1'
node scripts/smoke-development.mjs
```

## 尚未解决的部分

上文与验证 JSON 保留第一阶段的历史范围。2026-10-22 又完成[连续输入的数据复用与会话预算](search-input-implementation.md)：新输入重新完整召回 ID，只为未复用的 ID 读取排名列，缓存改用字节估算并保留活跃的大查询；该阶段独立记录全分页对照和桌面验收。

全盘紧凑目录替换仍未完成：新查询仍执行完整 SQL/FTS 召回，复制候选列，相关度仍需评价所有候选，所有分区也仍需排序。第一次返回页之前尚有这些成本，不能将“只归并首屏”误写为“只匹配首屏”。

名称描述可在相邻候选会话间复用，尚无持久化全局名字字典；路径仍为字符串，尚未改成父目录图按需重建。没有直接过滤旧匹配集合或复用匹配器状态。后续紧凑快照、增量覆盖、派生索引分阶段发布和首次建库改造仍按架构调查逐项验证。字节预算不是 RSS 硬限制，旧会话中的实时删除仍可能令实际可见项少于快照总数。

本轮没有重新建立 Listary 同机性能对照，也未以分区算法测试或绿色回归宣称已经达到 Listary 的即时体验。首次建库、离线大量变更、实际 Windows 重启仍需独立验收。
