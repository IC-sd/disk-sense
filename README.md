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
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## 📸 运行截图

<!-- 替换为你的实际截图路径 -->
<p align="center">
  <img src="screenshots/main.png" alt="Disk Sense 主界面" width="900">
</p>

---

## ✨ 功能特性

### 📁 文件浏览
- 安全标签分类（可清理 / 谨慎 / 勿删 / 待分析）
- 知识库自动匹配：147 条 Windows 路径规则 + 文件扩展名规则
- 多列排序：名称、大小、修改日期、创建日期、类型
- 全局搜索（Windows Search + PowerShell 双引擎回退）
- 面包屑导航 + 前进/后退/上级
- 目录缓存（15 秒有效期）

### 🗑 空间回收
- **15+ 清理类别**：临时文件、回收站、浏览器缓存、系统日志、Windows 更新缓存
- **社交软件缓存**：微信、QQ、企业微信、腾讯会议
- **系统瘦身**：休眠文件、虚拟内存、DISM 组件清理、驱动仓库分析
- WinSxS 组件存储分析
- DriverStore 驱动仓库扫描
- 系统还原点管理
- **安全删除**：全部走回收站，确认弹窗含预扫描明细

### 📊 磁盘变化分析
- 对比两次扫描结果，展示新增 / 删除 / 变化的文件
- 按变化量和时间线排序

### 🤖 AI 文件识别
- 接入 DeepSeek / OpenAI / OpenCode Go
- 支持自定义 API 地址和模型
- 同级目录上下文分析（参考 30 个同级文件判断关联性）
- 自动生成安全评级 + 清理建议
- 知识库辅助匹配：本地优先，LLM 兜底

### 🧹 系统瘦身（需管理员权限）
- 休眠文件管理：一键关闭/开启
- 系统组件清理：DISM StartComponentCleanup
- WinSxS 可回收组件分析
- DriverStore 旧驱动清理
- 虚拟内存优化引导

---

## 🏗 项目架构

```
disk-sense/
├── electron/              # Electron 主进程
│   ├── main.js            # 入口 + 窗口管理
│   ├── handlers.js        # IPC 处理器路由
│   ├── preload.js         # 安全桥接（29 个 API）
│   ├── windows-search.js  # Windows Search + PowerShell 双引擎
│   ├── rule-engine.js     # 安全规则引擎（147 条规则）
│   └── dism.js            # DISM / WinSxS / DriverStore 封装
├── src/                   # Vue 3 前端
│   ├── App.vue            # 应用壳（标题栏 + 侧栏 + 路由）
│   ├── pages/             # 页面组件
│   ├── components/        # 通用组件
│   ├── router/            # vue-router 路由定义
│   └── composables/       # 共享状态
├── knowledge/             # 知识库
│   └── windows.json       # 147 条规则
└── dist/                  # 构建产物
```

---

## 🚀 快速开始

```bash
# 克隆
git clone https://github.com/IC-sd/disk-sense.git
cd disk-sense

# 安装依赖
npm install

# 开发模式（Vite HMR 热更新）
npm run dev

# 生产构建
npm run build

# 启动
npm run start
```

---

## 🛠 打包

```bash
# 便携版（单 exe）
npm run pack

# 安装版
npm run dist
```

---

## ⚙ 配置

| 配置项 | 说明 |
|--------|------|
| API Key | DeepSeek / OpenAI / OpenCode Go |
| API 地址 | 自动根据提供商填充，支持自定义 |
| 模型 | deepseek-chat / gpt-4o / deepseek-v4-flash 等 |

配置持久化到 localStorage，重启不丢失。

---

## 📄 许可

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ using Electron + Vue.js</sub>
</p>
