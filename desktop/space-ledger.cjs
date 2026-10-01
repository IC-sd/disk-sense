const path = require('node:path')
const { createHash } = require('node:crypto')

const MAX_LOCATIONS = 512
const key = value => path.resolve(value).toLowerCase()
const contains = (root, target) => key(target) === key(root) || key(target).startsWith(key(root).replace(/[\\/]+$/u, '') + path.sep)
const like = value => value.replace(/[\\%_]/gu, character => `\\${character}`)

// Shares the search worker's SQLite connection. No filesystem crawl or main-thread JSON snapshot.
function createSpaceLedger(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS space_locations (
      path TEXT PRIMARY KEY COLLATE NOCASE, entity_id TEXT NOT NULL,
      relationship TEXT NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS space_locations_entity ON space_locations(entity_id);
    CREATE TABLE IF NOT EXISTS space_baselines (
      entity_id TEXT PRIMARY KEY, scope TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_gaps (
      path TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL
    );
  `)
  const rows = database.prepare('SELECT * FROM space_locations ORDER BY path COLLATE NOCASE')
  const stats = database.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
    FROM search_files WHERE is_directory = 0 AND is_link = 0
    AND (path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\')`)
  const baselineGet = database.prepare('SELECT * FROM space_baselines WHERE entity_id = ?')
  const gaps = database.prepare(`SELECT COUNT(*) AS count FROM search_gaps
    WHERE path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\'
    OR lower(substr(?, 1, length(path) + 1)) = lower(path || ?)`)
  const baselinePut = database.prepare(`INSERT INTO space_baselines VALUES (?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET scope=excluded.scope, bytes=excluded.bytes, created_at=excluded.created_at`)

  function observe(relationship) {
    if (!relationship?.entityId || !relationship.rootPath || !path.isAbsolute(relationship.rootPath)) return { saved: false }
    const root = path.resolve(relationship.rootPath)
    if (root === path.parse(root).root) return { saved: false }
    const existing = database.prepare('SELECT entity_id FROM space_locations WHERE path = ? COLLATE NOCASE').get(root)
    if (!existing && Number(database.prepare('SELECT COUNT(*) AS count FROM space_locations').get().count) >= MAX_LOCATIONS) return { saved: false, limited: true }
    database.prepare(`INSERT INTO space_locations VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET entity_id=excluded.entity_id, relationship=excluded.relationship, observed_at=excluded.observed_at`)
      .run(root, relationship.entityId, JSON.stringify(relationship), new Date().toISOString())
    if (existing && existing.entity_id !== relationship.entityId) baselinePut.run(existing.entity_id, '', 0, new Date().toISOString())
    return { saved: true }
  }

  let activeSummary = null
  let revision = 0
  async function summarize(getStatus) {
    const status = getStatus()
    const all = rows.all().map(row => ({ ...row, relationship: JSON.parse(row.relationship) }))
    const grouped = new Map()
    for (const row of all) {
      const list = grouped.get(row.entity_id) || []
      list.push(row)
      grouped.set(row.entity_id, list)
    }
    const entities = []
    const initialRevision = revision
    const baselineWrites = []
    let inspected = 0
    for (const [id, locations] of grouped) {
      // An observed cache inside an already counted project/install root is not added twice.
      const disjoint = locations.filter(location => !locations.some(other => other !== location && contains(other.path, location.path)))
      const details = []
      for (const location of locations) {
        const counts = stats.get(location.path, like(location.path.replace(/[\\/]+$/u, '') + path.sep) + '%')
        const gapCount = Number(gaps.get(location.path, like(location.path.replace(/[\\/]+$/u, '') + path.sep) + '%', location.path, path.sep).count)
        details.push({
          path: location.path, bytes: Number(counts.bytes), files: Number(counts.files),
          observedAt: location.observed_at, basis: location.relationship.basis,
          evidence: location.relationship.evidence || [],
          counted: disjoint.includes(location),
          covered: status.roots.some(root => contains(root, location.path)),
          incomplete: gapCount > 0,
          shared: all.some(other => other.entity_id !== id && (contains(other.path, location.path) || contains(location.path, other.path)))
        })
        if (++inspected % 8 === 0) await new Promise(resolve => setImmediate(resolve))
      }
      const bytes = details.filter(item => item.counted).reduce((sum, item) => sum + item.bytes, 0)
      const files = details.filter(item => item.counted).reduce((sum, item) => sum + item.files, 0)
      const stable = status.coverageVersion === 1 && status.phase === 'ready' && !status.building && !status.synchronizing && !status.pendingChanges && !status.truncated && !status.lastError && details.every(item => item.covered && !item.incomplete)
      const scope = createHash('sha256').update(JSON.stringify({
        roots: [...status.roots].sort(), locations: disjoint.map(item => [key(item.path), item.relationship.basis]).sort()
      })).digest('hex')
      let baseline = baselineGet.get(id)
      if (stable && baseline?.scope !== scope) {
        baseline = { scope, bytes, created_at: new Date().toISOString() }
        baselineWrites.push([id, scope, bytes, baseline.created_at])
      }
      const relationship = locations[0].relationship
      entities.push({
        id, name: relationship.entityName, kind: relationship.entityKind, type: relationship.entityType,
        bytes, files, locations: details,
        deltaBytes: stable && baseline?.scope === scope ? bytes - Number(baseline.bytes) : null,
        baselineAt: stable ? baseline?.created_at || null : null,
        inferred: locations.some(item => ['directory-convention', 'directory-name', 'icon-path'].includes(item.relationship.basis))
      })
    }
    const endStatus = getStatus()
    // A rebuild or watcher update during aggregation is not a comparable growth sample.
    const changed = initialRevision !== revision || status.revision !== endStatus.revision || status.startedAt !== endStatus.startedAt || status.completedAt !== endStatus.completedAt || status.lastChangedAt !== endStatus.lastChangedAt || endStatus.building || endStatus.synchronizing || endStatus.pendingChanges
    if (changed) for (const entity of entities) { entity.deltaBytes = null; entity.baselineAt = null }
    else for (const args of baselineWrites) baselinePut.run(...args)
    return {
      entities: entities.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
      generatedAt: new Date().toISOString(), index: endStatus,
      locationCount: all.length, limit: MAX_LOCATIONS,
      measurement: 'indexed-logical-bytes'
    }
  }

  return {
    observe(relationship) { const result = observe(relationship); if (result.saved) revision++; return result },
    forget(entityId) {
      if (typeof entityId !== 'string' || entityId.length > 2048) throw new Error('无效的空间归属标识')
      database.prepare('DELETE FROM space_locations WHERE entity_id = ?').run(entityId)
      database.prepare('DELETE FROM space_baselines WHERE entity_id = ?').run(entityId)
      revision++
      return { removed: true }
    },
    summary(getStatus) {
      if (!activeSummary) activeSummary = summarize(getStatus).finally(() => { activeSummary = null })
      return activeSummary
    },
    waitForIdle: () => activeSummary || Promise.resolve()
  }
}

module.exports = { createSpaceLedger, contains }
