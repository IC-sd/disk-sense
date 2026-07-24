<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="Disk Sense Logo">
</p>

<h1 align="center">Disk Sense</h1>

<p align="center">
  <strong>看懂每个目录与文件，再决定如何处理空间</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-43.x-47848F?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vuedotjs" alt="Vue.js">
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## 📸 运行截图

<p align="center">
  <img src="release/smoke-overview.png" alt="概览页面" width="600">
  <img src="release/smoke-inspect.png" alt="目录分析" width="600">
  <img src="release/smoke-cleaner.png" alt="空间清理" width="600">
  <img src="release/smoke-changes.png" alt="变化追踪" width="600">
</p>

---

## ✨ 功能特性

### 📁 目录与文件解释
- 从 `C:\` 开始按目录结构浏览
- 结合路径、名称、父级、同级、子项和内容摘要解释用途
- 识别常见浏览器、沟通工具、游戏平台和开发工具在 C/D 盘分散的数据位置
- 大目录使用虚拟渲染，目录容量异步抽样估算
- 五级风险判断：高风险 / 较高 / 重点 / 低风险 / 安全

### 🤖 AI 解释
- 接入 DeepSeek / OpenAI / OpenCode Go
- AI 解释目录和文件的用途与风险
- 清理建议生成
- 临时文件和可释放空间识别

### 🗑 空间清理
- 多类别垃圾文件扫描与清理
- 风险分类展示，安全删除
- 带文件预览的清理确认

### 📊 磁盘变化追踪
- 对比两次扫描结果，展示新增 / 删除 / 变化的文件
- 时间线排序与分类

### 🧰 系统诊断
- 系统信息采集与分析
- 应用归属识别

---

## 🏗 项目架构

```
disk-sense/
├── desktop/                    # Electron 主进程
│   ├── main.cjs                # 入口 + 窗口管理
│   ├── preload.cjs             # IPC 桥接
│   ├── handlers/               # IPC 处理器
│   │   ├── inspect-handlers.cjs
│   │   ├── cleaner-handlers.cjs
│   │   └── change-handlers.cjs
│   ├── ai-explainer.cjs        # AI 解释引擎
│   ├── explainer.cjs           # 文件解释器
│   ├── app-attribution.cjs     # 应用归属识别
│   ├── cleaner.cjs             # 清理引擎
│   ├── cleanup-executor.cjs    # 清理执行器
│   ├── change-tracker.cjs      # 变化追踪
│   ├── diagnostics.cjs         # 系统诊断
│   ├── risk.cjs                # 风险评估
│   ├── system-info.cjs         # 系统信息
│   └── state.cjs               # 状态管理
├── src/                        # Vue 3 + TypeScript 前端
│   ├── ui/                     # 界面组件
│   │   ├── App.vue             # 主应用
│   │   ├── OverviewPanel.vue   # 概览面板
│   │   ├── ExplorerPanel.vue   # 目录浏览
│   │   ├── CleanerPanel.vue    # 空间清理
│   │   ├── ChangesPanel.vue    # 变化追踪
│   │   ├── SettingsPanel.vue   # 设置
│   │   ├── CleanupHistoryPanel.vue
│   │   ├── AiSettingsModal.vue # AI 配置弹窗
│   │   └── AppIcon.vue
│   ├── application/            # 应用逻辑
│   │   ├── ai-session.ts       # AI 会话管理
│   │   └── ai-evidence.ts      # AI 证据记录
│   ├── domain/                 # 领域模型
│   │   ├── desktop.ts
│   │   └── risk.ts
│   └── shared/format.ts        # 通用工具
├── desktop/                    # 打包产物
│   ├── Disk Sense.exe          # 便携版
│   └── Disk Sense-Setup-*.exe  # 安装版
├── docs/                       # 文档
├── tests/                      # 测试
├── scripts/                    # 开发/构建脚本
└── .github/workflows/          # CI 配置
```

---

## 🚀 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（前端 HMR）
pnpm dev

# 桌面应用开发
pnpm dev:desktop

# 测试
pnpm test

# 构建
pnpm build

# 打包
pnpm pack
```

---

## 📄 许可

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ using Electron + Vue.js + TypeScript</sub>
</p>
