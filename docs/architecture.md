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
  ├─ change tracker
  ├─ AI adapter
  └─ atomic local state
```

- Renderer：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- Preload：只暴露明确列出的 `diskSense` 方法，不暴露任意 IPC。
- Main：拒绝新窗口和页面导航；生产页面使用本地 `file://` 资源。
- State：写入临时文件后原子替换，只用有效主文件更新备份；大型变化基线单独保存，普通设置变更不会重复序列化十几万条元数据。

## 目录解释

目录浏览只加载当前层，文件状态使用有界并发读取，列表虚拟渲染；目录容量只为当前可见项执行有时间、节点和短期缓存上限的异步估算。解释器结合路径、名称、父级、同级、有限子项、文件签名和有限文本预览。未知对象只能标记为需要进一步判断，不会自动进入清理。

AI 是可选的第二层解释。API 密钥由 Windows `safeStorage` 加密后本地保存；远程接口必须使用 HTTPS。发送证据有数量和长度上限，常见密钥、令牌和密码格式会先被遮盖，不会批量上传文件。分析结果只在当前应用进程中保留，采用 500 条 LRU 上限。

## 清理执行

```text
rule scan
  → age/process/path/user-exclusion filters
  → opaque candidate id
  → user selection
  → process recheck
  → user-exclusion recheck
  → canonical path + identity recheck
  → Windows Recycle Bin
  → per-file audit
```

扫描和执行之间最多间隔 30 分钟。规则只能生成候选项，不能直接删除。清理执行器不接受 renderer 提供的任意路径，只接受主进程候选保险库中仍有效的随机标识。每个任务保留完整汇总，长期逐文件审计最多保存 1,000 条并优先保留失败项，避免状态文件无限增长。

## 变化记录

变化扫描有时间和条目上限，为每个磁盘分配公平预算，并跳过符号链接、目录联接、回收站和系统卷元数据。若两次扫描不是完整覆盖，只比较两次都访问过的父目录，避免把未扫描区域误报成新增或删除。移动只在唯一文件指纹一一对应时推断，目录树新增/删除会聚合已覆盖的后代空间。UI 会逐盘标注覆盖情况。

## 发布验证

`pnpm validate` 依次运行 Vue 类型检查、自动化测试、所有桌面模块语法检查和生产构建。`scripts/smoke-desktop.mjs` 使用隔离的临时用户数据目录，通过打包应用的真实 renderer/preload/main 链路切换页面并进行只读冒烟验证。
