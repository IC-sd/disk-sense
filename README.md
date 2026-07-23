<p align="center">
  <img src="https://img.icons8.com/fluency/96/null/waste--v1.png" width="96" height="96" alt="Disk Sense Logo">
</p>

<h1 align="center">Disk Sense</h1>

<p align="center">
  <strong>磁盘智能分析 · 清理 · 优化</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-30.x-47848F?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vuedotjs" alt="Vue.js">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## ✨ 功能特性

### 📁 文件浏览
- 安全标签分类（可清理 / 谨慎 / 勿删 / 待分析）
- 多列排序：名称、大小、修改日期、创建日期
- 知识库辅助匹配识别文件用途

### 🗑 空间回收
- 多类别垃圾文件扫描与清理
- 社交软件缓存清理（微信、QQ 等）
- 系统临时文件、浏览器缓存、回收站

### 📊 磁盘变化分析
- 对比两次扫描结果，展示新增 / 删除 / 变化的文件
- AI 辅助分析变化原因

### 🤖 AI 文件识别
- 接入 DeepSeek / OpenAI / OpenCode Go
- AI 解释文件用途与风险等级
- 清理建议生成
- 文件属性自动标注

---

## 🏗 项目架构

```
disk-sense/
├── desktop/               # Electron 主进程
│   ├── main.cjs           # 入口 + 窗口管理
│   ├── preload.cjs        # IPC 桥接
│   ├── scanner.cjs        # 文件扫描引擎
│   ├── cleaner.cjs        # 清理引擎
│   ├── ai-explainer.cjs   # AI 解释器
│   ├── change-tracker.cjs # 变化追踪
│   ├── explainer.cjs      # 文件解释器
│   ├── app-attribution.cjs# 应用归属识别
│   ├── duplicates.cjs     # 重复文件检测
│   └── state.cjs          # 状态管理
├── src/                   # Vue 3 + TypeScript 前端
│   ├── ui/                # 界面组件
│   │   ├── App.vue        # 主应用
│   │   ├── CleanerPanel.vue
│   │   ├── ChangesPanel.vue
│   │   ├── AiSettingsModal.vue
│   │   ├── theme.css
│   │   └── extra.css
│   ├── platform/api.ts    # API 层
│   ├── application/       # 应用逻辑
│   ├── domain/            # 领域模型
│   └── main.ts            # 入口
├── docs/                  # 文档
├── tests/                 # 测试
└── dist/                  # 构建产物
```

---

## 🚀 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（前端热更新）
pnpm dev

# 桌面应用开发模式
pnpm dev:desktop

# 构建
pnpm build

# 测试
pnpm test
```

---

## 📄 许可

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ using Electron + Vue.js + TypeScript</sub>
</p>
