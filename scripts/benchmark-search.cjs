const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const { rankAndOrganizeRows } = require('../desktop/file-search.cjs')

const databasePath = process.argv[2]
const query = String(process.argv[3] || '').trim().toLowerCase()
const candidateLimit = Math.max(1, Math.min(2000, Number(process.argv[4] || 525)))

if (!databasePath || !query) {
  console.error('Usage: node scripts/benchmark-search.cjs <database-path> <query>')
  process.exitCode = 1
  return
}

const database = new DatabaseSync(databasePath, { readOnly: true })
const fileStem = name => {
  const value = String(name || '')
  const extension = path.extname(value)
  return extension ? value.slice(0, -extension.length) : value
}
const started = performance.now()
const rows = database.prepare(`
  SELECT file.path, file.name, file.root, file.kind,
    file.is_directory, file.is_link, file.size, file.modified_at
  FROM search_files AS file
  JOIN search_fts ON search_fts.rowid = file.rowid
  WHERE search_fts MATCH ?
  ORDER BY
    CASE
      WHEN file.name = ? COLLATE NOCASE THEN 0
      WHEN file.name LIKE ? ESCAPE '\\' THEN 1
      WHEN file.name LIKE ? ESCAPE '\\' THEN 2
      WHEN file.name LIKE ? ESCAPE '\\' THEN 3
      ELSE 4
    END,
    CASE
      WHEN file.kind = 'application' THEN 0
      WHEN file.is_directory = 1 THEN 1
      WHEN file.kind IN ('document', 'image', 'video', 'audio', 'archive') THEN 2
      ELSE 3
    END,
    file.modified_at DESC, LENGTH(file.path) ASC, file.name ASC
  LIMIT ?
`).all(
  `"${query.replaceAll('"', '""')}"`,
  query,
  `${query}.%`,
  `${query}%`,
  `%${query}%`,
  candidateLimit
)

const ranked = rankAndOrganizeRows(rows, query)

console.log(JSON.stringify({
  query,
  schemaVersion: Number(database.prepare('PRAGMA user_version').get()?.user_version || 0),
  candidateLimit,
  candidates: rows.length,
  tookMs: Number((performance.now() - started).toFixed(2)),
  kindCounts: database.prepare(`
    SELECT kind, COUNT(*) AS count
    FROM search_files
    WHERE kind IN ('application', 'installer')
    GROUP BY kind
    ORDER BY kind
  `).all(),
  top: ranked.rows.slice(0, 20).map(item => {
    const ranking = ranked.rankingFor(item)
    const extension = path.extname(item.name).toLowerCase()
    return {
      name: item.name,
      displayName: item.kind === 'application' && ['.lnk', '.url', '.appref-ms'].includes(extension)
        ? fileStem(item.name)
        : item.name,
      path: item.path,
      modifiedAt: new Date(Number(item.modified_at)).toISOString(),
      score: ranking.score,
      priority: ranking.priority,
      reason: ranking.reason
    }
  })
}, null, 2))

database.close()
