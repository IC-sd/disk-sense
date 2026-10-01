# Architecture

Disk Sense 是单窗口 Windows 桌面应用。渲染层只负责展示和提交意图；文件系统、系统状态、网络模型请求和回收站操作由 Electron 后端执行。全盘搜索索引和空间台账共用一个工作线程中的 SQLite 数据库。

## 运行边界

```text
Vue UI
  ↓ typed DesktopApi
sandboxed preload
  ↓ allowlisted IPC
Electron main
  ├─ volume overview + runtime diagnostics
  ├─ isolated IPC handler modules
  ├─ explainer + app attribution
  ├─ search worker → file index + coverage gaps + space ledger
  ├─ cleanup scanner + candidate vault + executor
  ├─ foreground disk-operation coordinator
  ├─ allowlisted Windows maintenance adapter
  ├─ change tracker
  ├─ AI adapter
  └─ atomic local state
```

- Renderer：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- Preload：只暴露明确列出的 `diskSense` 方法，不暴露任意 IPC。
- Main：拒绝新窗口、页面导航和所有未使用的 renderer 权限；生产页面使用本地 `file://` 资源。
- State：写入临时文件后原子替换，只用有效主文件更新备份；大型变化基线和持续增长的清理、维护、AI 解释历史分别保存，普通设置变更不会重复写入这些重数据。

## 目录解释

目录浏览只加载当前层，文件状态使用有界并发读取，列表虚拟渲染；目录容量只为当前可见项执行有时间、节点和短期缓存上限的异步估算。解释器结合路径、名称、父级、同级、有限子项、文件签名和有限文本预览。未知对象只能标记为需要进一步判断，不会自动进入清理。

归属判定区分安装登记、项目清单、图标位置、已知路径特征和名称推断。共享安装根或重名产品不会按枚举顺序选一个归属。依赖包自己的清单保留为组件证据，归属追溯到使用该依赖的项目；独立嵌套项目仍保留自己的根。跨磁盘关联时，数据角色由实际数据路径判断，不截取不相干的安装路径长度。

AI 是可选的第二层解释。API 密钥由 Windows `safeStorage` 加密后本地保存；远程接口必须使用 HTTPS。发送证据有数量和长度上限，常见密钥、令牌和密码格式会先被遮盖，不会批量上传文件。分析结论以路径和证据指纹保存在本地，最多保留 1,000 条。指纹包含对象状态、父级项目标记、归属、规则版本和有限内容证据。选中对象后重新核实证据；AI 请求结束时再次核实，过期结果不会套用到更新后的对象或另一项选择。本地已经确认的归属和风险由后端及展示层共同保留。

## 空间台账

`space-ledger.cjs` 保存已观察到的实体、根位置、证据类型和最近核实时间。安装位置可由用户主动识别；浏览和搜索解释会记录项目或应用的数据根。猜测出的相关位置只有经过本地核实才可以成为台账记录，AI 不写入归属。移除归属记录只影响台账，不删除磁盘文件。

台账从已有搜索索引聚合逻辑大小，不重新遍历目录。同一实体的嵌套根只累加最上层，跨实体重叠范围显式标注，不能把各软件的数字直接相加。统计排除链接；硬链接、稀疏文件和压缩文件的逻辑大小仍不等于实际磁盘分配或可释放空间。每个实体最多使用当前已核实的关联位置，不能据此声称已经覆盖该软件的所有文件。

覆盖缺口按具体路径保存在 `search_gaps`。权限错误保留旧索引记录并暂停受影响位置的变化比较，其他完整覆盖位置仍可比较；后续扫描成功再更新记录。索引限额、重建、增量处理、待处理事件或扫描范围变化会暂停比较或建立新的比较起点。聚合期间通过索引修订号检查并发变化，范围不同的两次读数不会形成增长结论。台账有 512 个位置的明确上限，已有记录不会被自动挤出。

## 清理执行

```text
rule scan
  → record recognized occupancy
  → age/process/path/user-exclusion filters
  → opaque candidate id
  → user selection
  → process recheck
  → user-exclusion recheck
  → canonical path + identity recheck
  → Windows Recycle Bin
  → per-file audit
```

扫描首先统计规则明确认识的空间，再把满足保留时间、进程状态和路径条件的文件放入候选保险库；因此“发现占用”不等于“当前可处理”。扫描和执行之间最多间隔 30 分钟。规则只能生成候选项，不能直接删除。清理执行器不接受 renderer 提供的任意路径，只接受主进程候选保险库中仍有效的随机标识。每个任务保留完整汇总，长期逐文件审计最多保存 1,000 条并优先保留失败项，避免状态文件无限增长。

系统维护不复用普通文件清理入口。渲染层只能提交预定义操作标识和确认词；主进程从固定白名单选择 Windows `System32` 下的绝对可执行文件与参数，以 `shell: false` 运行，并在执行前再次确认管理员权限。DISM 常规清理与不可逆 ResetBase 分开建模，虚拟内存和 Windows.old 只打开 Windows 官方设置。

变化扫描、垃圾扫描、实际清理、系统维护和数据目录迁移共享主进程任务协调器。多个只读垃圾规则可以并行扫描；会改变磁盘状态或建立空间快照的任务互斥，防止跨页面并发导致磁盘争抢和错误变化结论。

## 变化记录

变化扫描有时间和条目上限，为每个磁盘分配公平预算，并跳过符号链接、目录联接、回收站和系统卷元数据。只有完整检查过子项的目录才标记为已覆盖；若两次扫描不是完整覆盖，只比较有相应覆盖依据的父目录。移动使用卷内文件身份和创建时间，64 位文件标识保存为字符串，存在多个硬链接或缺少身份时保留为新增与移除，大小和修改时间相同不再被当作移动证明。目录树新增/移除会聚合已覆盖的后代空间，文件修改与移动过程中的大小变化分别计算。UI 会逐盘标注覆盖情况。

## 发布验证

`pnpm validate` 依次运行 Vue 类型检查、自动化测试、所有桌面模块语法检查和生产构建。`scripts/smoke-development.mjs` 验证真实 Electron 与动态 Vite 热更新链路；`scripts/smoke-desktop.mjs` 使用隔离的临时用户数据目录，通过打包应用的真实 renderer/preload/main 链路切换页面并进行只读冒烟验证。
