# Architecture

Disk Sense 是单窗口 Windows 桌面应用。渲染层只负责展示和提交意图；文件系统、系统状态、网络模型请求和回收站操作全部位于 Electron 主进程。

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
- State：写入临时文件后原子替换，只用有效主文件更新备份；大型变化基线单独保存，普通设置变更不会重复序列化十几万条元数据。

## 目录解释

目录浏览只加载当前层，文件状态使用有界并发读取，列表虚拟渲染；目录容量只为当前可见项执行有时间、节点和短期缓存上限的异步估算。解释器结合路径、名称、父级、同级、有限子项、文件签名和有限文本预览。未知对象只能标记为需要进一步判断，不会自动进入清理。

AI 是可选的第二层解释。API 密钥由 Windows `safeStorage` 加密后本地保存；远程接口必须使用 HTTPS。发送证据有数量和长度上限，常见密钥、令牌和密码格式会先被遮盖，不会批量上传文件。分析结论以路径和文件状态指纹保存在本地，最多保留 1,000 条；对象发生变化后旧结论会标记为过期，而不是继续冒充当前判断。

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

变化扫描有时间和条目上限，为每个磁盘分配公平预算，并跳过符号链接、目录联接、回收站和系统卷元数据。若两次扫描不是完整覆盖，只比较两次都访问过的父目录，避免把未扫描区域误报成新增或删除。移动只在唯一文件指纹一一对应时推断，目录树新增/删除会聚合已覆盖的后代空间。UI 会逐盘标注覆盖情况。

## 发布验证

`pnpm validate` 依次运行 Vue 类型检查、自动化测试、所有桌面模块语法检查和生产构建。`scripts/smoke-development.mjs` 验证真实 Electron 与动态 Vite 热更新链路；`scripts/smoke-desktop.mjs` 使用隔离的临时用户数据目录，通过打包应用的真实 renderer/preload/main 链路切换页面并进行只读冒烟验证。
