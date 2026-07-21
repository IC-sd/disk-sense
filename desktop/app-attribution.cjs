const path = require('node:path')
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
module.exports = { attribute, storageRelationship, signatures }
