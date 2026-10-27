'use strict'
const RISK = { safe: 0, low: 1, attention: 2, elevated: 3, danger: 4 }
function loadRuleCatalog(catalog, providers) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.rules) || catalog.rules.length > 500) throw new Error('清理规则目录格式无效')
  const registry = new Map(providers.map(provider => [provider.id, provider]))
  const seen = new Set()
  return catalog.rules.map(definition => {
    const provider = registry.get(definition?.id)
    if (!provider || seen.has(definition.id) || !/^[a-z0-9-]{1,80}$/.test(definition.id)) throw new Error('清理规则标识无效或重复')
    seen.add(definition.id)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error('清理规则版本无效')
    for (const key of ['title', 'category', 'reason', 'safetyNote', 'source']) {
      if (typeof definition[key] !== 'string' || !definition[key].trim() || definition[key].length > 3000) throw new Error(`清理规则缺少有效的 ${key}`)
    }
    if (!Object.hasOwn(RISK, definition.risk) || RISK[definition.risk] < RISK[provider.risk]) throw new Error('规则不能降低内置风险保护')
    if (typeof definition.selectable !== 'boolean' || (definition.selectable && !provider.selectable)) throw new Error('规则不能开启未授权的处理动作')
    if (!Number.isSafeInteger(definition.minimumAgeDays) || definition.minimumAgeDays < provider.minimumAgeDays || definition.minimumAgeDays > 36500) throw new Error('规则不能缩短内置保留时间')
    if (definition.processNames !== undefined && !Array.isArray(definition.processNames)) throw new Error('无效的规则进程保护')
    const processNames = [...new Set([...(provider.processNames || []), ...(definition.processNames || [])])]
    if (processNames.length > 100 || processNames.some(name => typeof name !== 'string' || !/^[^\\/\x00-\x1f]{1,120}\.exe$/i.test(name))) throw new Error('无效的规则进程保护')
    return Object.freeze({ ...provider, title: definition.title, category: definition.category, reason: definition.reason,
      safetyNote: definition.safetyNote, risk: definition.risk, minimumAgeDays: definition.minimumAgeDays,
      selectable: definition.selectable, processNames, version: definition.version, source: definition.source })
  })
}
module.exports = { loadRuleCatalog }
