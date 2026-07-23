const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const signatures = [
  { id: 'chrome', name: 'Google Chrome', patterns: ['google\\chrome', 'chrome\\user data'] },
  { id: 'edge', name: 'Microsoft Edge', patterns: ['microsoft\\edge', 'edge\\user data'] },
  { id: 'steam', name: 'Steam', patterns: ['steam\\appcache', 'steam\\shadercache'] },
  { id: 'node', name: 'Node.js / npm', patterns: ['npm-cache', 'node_modules'] },
  { id: 'android-studio', name: 'Android Studio', patterns: ['.gradle', 'androidstudio'] },
  { id: 'jetbrains', name: 'JetBrains IDE', patterns: ['jetbrains', '.cache\\jetbrains'] }
]
function attribute(filePath) {
  const normalized = filePath.toLowerCase().replaceAll('/', '\\')
  const match = signatures.find(item => item.patterns.some(pattern => normalized.includes(pattern)))
  return match ? { id: match.id, name: match.name, evidence: `path contains a ${match.name} signature` } : null
}
function storageRelationship(filePath) {
  const root = /^[A-Za-z]:[\\/]/.test(filePath) ? `${filePath[0].toUpperCase()}:\\` : path.parse(filePath).root
  const owner = attribute(filePath)
  return { volume: root, owner, systemDisk: root.toLowerCase() === 'c:\\' }
}

function availableVolumes() {
  if (process.platform !== 'win32') return [path.parse(os.homedir()).root]
  const volumes = []
  for (let code = 65; code <= 90; code++) {
    const volume = `${String.fromCharCode(code)}:\\`
    try { if (fs.existsSync(volume)) volumes.push(volume) } catch { /* inaccessible volume */ }
  }
  return volumes
}

function findRelatedLocations(filePath) {
  const owner = attribute(filePath)
  if (!owner) return []
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const candidates = []
  const add = (value, reason) => { if (value && fs.existsSync(value) && path.resolve(value).toLowerCase() !== path.resolve(filePath).toLowerCase()) candidates.push({ path: value, reason, volume: path.parse(value).root }) }
  for (const volume of availableVolumes()) {
    const pf = path.join(volume, 'Program Files')
    const pfx86 = path.join(volume, 'Program Files (x86)')
    if (owner.id === 'chrome') { add(path.join(local, 'Google', 'Chrome'), 'Chrome 用户数据'); add(path.join(roaming, 'Google', 'Chrome'), 'Chrome 用户配置'); add(path.join(pf, 'Google', 'Chrome'), 'Chrome 安装位置') }
    if (owner.id === 'edge') { add(path.join(local, 'Microsoft', 'Edge'), 'Edge 用户数据'); add(path.join(pf, 'Microsoft', 'Edge'), 'Edge 安装位置') }
    if (owner.id === 'steam') { add(path.join(pf, 'Steam'), 'Steam 安装位置'); add(path.join(pfx86, 'Steam'), 'Steam 安装位置'); add(path.join(local, 'Steam'), 'Steam 用户数据') }
    if (owner.id === 'node') { add(path.join(local, 'npm-cache'), 'npm 缓存'); add(path.join(pf, 'nodejs'), 'Node.js 安装位置') }
    if (owner.id === 'android-studio') { add(path.join(home, '.gradle'), 'Gradle 用户缓存'); add(path.join(pf, 'Android'), 'Android 工具安装位置') }
    if (owner.id === 'jetbrains') { add(path.join(local, 'JetBrains'), 'JetBrains 本地数据'); add(path.join(roaming, 'JetBrains'), 'JetBrains 配置数据'); add(path.join(pf, 'JetBrains'), 'JetBrains 安装位置') }
  }
  const seen = new Set(); return candidates.filter(item => { const key = item.path.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, 12)
}
module.exports = { attribute, storageRelationship, signatures, findRelatedLocations }
