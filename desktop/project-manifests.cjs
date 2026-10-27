const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const MAX_MANIFEST_BYTES = 64 * 1024

function clean(value) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) : '' }
function tomlSection(text, names) {
  const sections = String(text).split(/(?=^\s*\[[^\]]+\]\s*$)/m)
  return sections.find(section => names.some(name => section.match(/^\s*\[([^\]]+)\]/)?.[1] === name)) || ''
}
function quotedField(text, name) { return clean(text.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"'\\r\\n]*)["']`, 'm'))?.[1]) }

function parseProjectManifest(catalogId, text, fileName) {
  if (catalogId === 'node' || catalogId === 'php') {
    const body = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('清单不是对象')
    return { name: clean(body.productName) || clean(body.name), version: clean(body.version), declaredDependencies: Object.keys(body.dependencies || {}).length }
  }
  if (catalogId === 'rust' || catalogId === 'python') {
    if (!/\.toml$/i.test(fileName)) return { name: '', version: '', note: '仅识别项目标记，不执行 Python 安装脚本' }
    const section = tomlSection(text, catalogId === 'rust' ? ['package'] : ['project', 'tool.poetry'])
    return { name: quotedField(section, 'name'), version: quotedField(section, 'version') }
  }
  if (catalogId === 'go') return { name: clean(text.match(/^\s*module\s+(?:"([^"]+)"|([^\s]+))/m)?.slice(1).find(Boolean)), version: '' }
  if (catalogId === 'java') {
    // POM project fields only, excluding parent/dependency properties. Never resolve entities.
    const project = text.replace(/<parent\b[\s\S]*?<\/parent>/gi, '').replace(/<dependencies\b[\s\S]*?<\/dependencies>/gi, '')
    return { name: clean(project.match(/<artifactId>\s*([^<]+)<\/artifactId>/)?.[1]), version: clean(project.match(/<version>\s*([^<]+)<\/version>/)?.[1]) }
  }
  if (catalogId === 'dotnet') return { name: clean(text.match(/<AssemblyName>\s*([^<]+)<\/AssemblyName>/)?.[1]), version: clean(text.match(/<(?:Version|VersionPrefix)>\s*([^<]+)<\/(?:Version|VersionPrefix)>/)?.[1]) }
  return { name: '', version: '' }
}

async function readProjectManifest(rootPath, catalog, names = []) {
  const preference = { node: ['package.json'], php: ['composer.json'], rust: ['cargo.toml'], python: ['pyproject.toml', 'requirements.txt', 'setup.py'], go: ['go.mod'], java: ['pom.xml', 'build.gradle', 'build.gradle.kts'], dotnet: [] }
  const candidates = names.filter(name => catalog.primaryMatches.some(marker => name.toLowerCase() === marker || name.toLowerCase().endsWith(marker)))
  candidates.sort((a, b) => {
    const order = preference[catalog.id] || []
    const rank = value => order.indexOf(value.toLowerCase()) < 0 ? order.length : order.indexOf(value.toLowerCase())
    return rank(a) - rank(b)
  })
  for (const fileName of candidates) {
    let handle
    try {
      const fullPath = path.join(rootPath, fileName)
      const initial = await fsp.lstat(fullPath)
      if (!initial.isFile() || initial.isSymbolicLink()) continue
      if (initial.size > MAX_MANIFEST_BYTES) return { fileName, status: 'oversized', bytes: 0, maximumBytes: MAX_MANIFEST_BYTES }
      handle = await fsp.open(fullPath, 'r')
      const current = await handle.stat()
      if (current.ino !== initial.ino || current.dev !== initial.dev || current.size > MAX_MANIFEST_BYTES) return { fileName, status: 'changed', bytes: 0 }
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const prefix = buffer.subarray(0, bytesRead)
      const digest = createHash('sha256').update(prefix).digest('hex')
      try {
        return { fileName, status: 'parsed', bytes: bytesRead, digest, ...parseProjectManifest(catalog.id, prefix.toString('utf8'), fileName) }
      } catch { return { fileName, status: 'invalid', bytes: bytesRead, digest } }
    } catch { /* optional manifest unavailable; continue other primary markers */ }
    finally { try { await handle?.close() } catch { /* ignore close failures */ } }
  }
  return { status: 'markers-only', bytes: 0 }
}

module.exports = { MAX_MANIFEST_BYTES, parseProjectManifest, readProjectManifest }
