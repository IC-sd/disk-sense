const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const signatures = [
  { id: 'chrome', name: 'Google Chrome', patterns: ['\\google\\chrome\\', '\\chrome\\user data\\'] },
  { id: 'edge', name: 'Microsoft Edge', patterns: ['\\microsoft\\edge\\', '\\edge\\user data\\'] },
  { id: 'firefox', name: 'Mozilla Firefox', patterns: ['\\mozilla\\firefox\\', '\\firefox\\profiles\\'] },
  { id: 'steam', name: 'Steam', patterns: ['\\steam\\appcache\\', '\\steam\\steamapps\\', '\\steam\\config\\'] },
  { id: 'epic', name: 'Epic Games', patterns: ['\\epicgameslauncher\\', '\\epic games\\launcher\\'] },
  { id: 'vscode', name: 'Visual Studio Code', patterns: ['\\code\\user\\', '\\code\\cacheddata\\', '\\.vscode\\'] },
  { id: 'discord', name: 'Discord', patterns: ['\\discord\\cache\\', '\\discord\\local storage\\', '\\discord\\code cache\\'] },
  { id: 'wechat', name: '微信', patterns: ['\\tencent\\wechat\\', '\\wechat files\\', '\\xwechat\\'] },
  { id: 'qq', name: 'QQ', patterns: ['\\tencent\\qq\\', '\\tencent files\\', '\\qqnt\\'] },
  { id: 'dingtalk', name: '钉钉', patterns: ['\\dingtalk\\', '\\alibaba\\dingtalk\\'] },
  { id: 'feishu', name: '飞书', patterns: ['\\bytedance\\feishu\\', '\\lark\\user data\\', '\\feishu\\'] },
  { id: 'teams', name: 'Microsoft Teams', patterns: ['\\microsoft\\teams\\', '\\ms-teams\\'] },
  { id: 'docker', name: 'Docker Desktop', patterns: ['\\docker\\wsl\\', '\\dockerdesktop\\', '\\docker desktop\\'] },
  { id: 'android-studio', name: 'Android Studio', patterns: ['\\.android\\', '\\androidstudio', '\\android\\sdk\\'] },
  { id: 'jetbrains', name: 'JetBrains IDE', patterns: ['\\jetbrains\\', '\\.cache\\jetbrains\\'] },
  { id: 'gradle', name: 'Gradle', patterns: ['\\.gradle\\caches\\', '\\gradle\\caches\\'] },
  { id: 'maven', name: 'Maven', patterns: ['\\.m2\\repository\\', '\\apache-maven\\'] },
  { id: 'nuget', name: 'NuGet', patterns: ['\\.nuget\\packages\\', '\\nuget\\cache\\'] },
  { id: 'python', name: 'Python / pip', patterns: ['\\pip\\cache\\', '\\python\\python', '\\__pycache__\\'] },
  { id: 'node', name: 'Node.js / npm', patterns: ['\\npm-cache\\', '\\.npm\\', '\\node_modules\\', '\\pnpm-store\\'] }
]

function normalizedPath(filePath) {
  return `\\${String(filePath || '').toLowerCase().replaceAll('/', '\\').replace(/^\\+/, '')}`
}

function attribute(filePath) {
  const normalized = normalizedPath(filePath)
  for (const signature of signatures) {
    const matchedPattern = signature.patterns.find(pattern => normalized.includes(pattern))
    if (matchedPattern) {
      return {
        id: signature.id,
        name: signature.name,
        evidence: `路径包含 ${signature.name} 的特征片段`,
        matchedPattern
      }
    }
  }
  return null
}

function storageRelationship(filePath) {
  const root = /^[A-Za-z]:[\\/]/.test(filePath) ? `${filePath[0].toUpperCase()}:\\` : path.parse(filePath).root
  const owner = attribute(filePath)
  return { volume: root, owner, systemDisk: root.toLowerCase() === 'c:\\' }
}

function availableVolumes() {
  if (process.platform !== 'win32') return [path.parse(os.homedir()).root]
  const result = []
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(root)) result.push(root)
    } catch {
      // Disconnected and protected volumes are omitted.
    }
  }
  return result
}

function locationTemplates(ownerId, context) {
  const { home, local, roaming } = context
  const templates = {
    chrome: [
      [path.join(local, 'Google', 'Chrome', 'User Data'), 'Chrome 用户资料与缓存'],
      [path.join(roaming, 'Google', 'Chrome'), 'Chrome 漫游配置']
    ],
    edge: [[path.join(local, 'Microsoft', 'Edge', 'User Data'), 'Edge 用户资料与缓存']],
    firefox: [
      [path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'), 'Firefox 用户资料'],
      [path.join(local, 'Mozilla', 'Firefox', 'Profiles'), 'Firefox 本地缓存']
    ],
    steam: [[path.join(local, 'Steam'), 'Steam 本地应用数据']],
    epic: [[path.join(local, 'EpicGamesLauncher'), 'Epic 启动器本地数据']],
    vscode: [
      [path.join(roaming, 'Code'), 'VS Code 用户配置与工作区状态'],
      [path.join(home, '.vscode'), 'VS Code 扩展和用户数据']
    ],
    discord: [
      [path.join(roaming, 'discord'), 'Discord 用户数据'],
      [path.join(local, 'Discord'), 'Discord 程序与更新数据']
    ],
    wechat: [
      [path.join(home, 'Documents', 'WeChat Files'), '微信聊天文件默认位置'],
      [path.join(roaming, 'Tencent', 'WeChat'), '微信用户配置']
    ],
    qq: [
      [path.join(home, 'Documents', 'Tencent Files'), 'QQ 用户文件默认位置'],
      [path.join(roaming, 'Tencent', 'QQ'), 'QQ 用户配置']
    ],
    dingtalk: [
      [path.join(roaming, 'DingTalk'), '钉钉用户配置'],
      [path.join(local, 'DingTalk'), '钉钉本地数据']
    ],
    feishu: [
      [path.join(roaming, 'Lark'), '飞书用户配置'],
      [path.join(local, 'Lark'), '飞书本地数据']
    ],
    teams: [
      [path.join(local, 'Microsoft', 'Teams'), 'Teams 本地数据'],
      [path.join(roaming, 'Microsoft', 'Teams'), 'Teams 用户配置']
    ],
    docker: [
      [path.join(local, 'Docker'), 'Docker Desktop 本地数据'],
      [path.join(local, 'Docker', 'wsl'), 'Docker WSL 虚拟磁盘']
    ],
    'android-studio': [
      [path.join(home, '.android'), 'Android 开发工具用户数据'],
      [path.join(local, 'Android', 'Sdk'), 'Android SDK']
    ],
    jetbrains: [
      [path.join(local, 'JetBrains'), 'JetBrains 缓存与本地数据'],
      [path.join(roaming, 'JetBrains'), 'JetBrains 用户配置']
    ],
    gradle: [[path.join(home, '.gradle'), 'Gradle 用户缓存']],
    maven: [[path.join(home, '.m2', 'repository'), 'Maven 本地仓库']],
    nuget: [[path.join(home, '.nuget', 'packages'), 'NuGet 全局包缓存']],
    python: [[path.join(local, 'pip', 'Cache'), 'pip 下载与构建缓存']],
    node: [
      [path.join(local, 'npm-cache'), 'npm 缓存'],
      [path.join(home, '.npm'), 'npm 用户缓存']
    ]
  }
  return templates[ownerId] || []
}

function installFolderNames(ownerId) {
  return {
    chrome: [['Google', 'Chrome']],
    edge: [['Microsoft', 'Edge']],
    firefox: [['Mozilla Firefox']],
    steam: [['Steam']],
    epic: [['Epic Games', 'Launcher']],
    vscode: [['Microsoft VS Code']],
    discord: [['Discord']],
    wechat: [['Tencent', 'WeChat']],
    qq: [['Tencent', 'QQNT'], ['Tencent', 'QQ']],
    dingtalk: [['DingTalk']],
    feishu: [['Lark'], ['Feishu']],
    teams: [['Microsoft', 'Teams']],
    docker: [['Docker', 'Docker']],
    'android-studio': [['Android', 'Android Studio']],
    jetbrains: [['JetBrains']],
    python: [['Python']],
    node: [['nodejs']]
  }[ownerId] || []
}

function findRelatedLocations(filePath) {
  const owner = attribute(filePath)
  if (!owner) return []
  const home = os.homedir()
  const context = {
    home,
    local: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    roaming: process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  }
  const candidates = []
  const current = path.resolve(filePath).toLowerCase()
  const add = (value, reason) => {
    try {
      if (!value || !fs.existsSync(value) || path.resolve(value).toLowerCase() === current) return
      candidates.push({ path: value, reason, volume: path.parse(value).root })
    } catch {
      // A related protected location is simply not exposed.
    }
  }

  for (const [location, reason] of locationTemplates(owner.id, context)) add(location, reason)
  for (const volume of availableVolumes()) {
    for (const segments of installFolderNames(owner.id)) {
      add(path.join(volume, 'Program Files', ...segments), `${owner.name} 安装位置`)
      add(path.join(volume, 'Program Files (x86)', ...segments), `${owner.name} 安装位置`)
    }
  }

  const seen = new Set()
  return candidates.filter(item => {
    const itemKey = item.path.toLowerCase()
    if (seen.has(itemKey)) return false
    seen.add(itemKey)
    return true
  }).slice(0, 16)
}

module.exports = {
  attribute,
  storageRelationship,
  signatures,
  findRelatedLocations,
  locationTemplates,
  installFolderNames,
  normalizedPath
}
