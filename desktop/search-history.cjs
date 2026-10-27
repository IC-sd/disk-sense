const normalizeQuery = query => String(query || '').trim().toLowerCase().replace(/\s+/gu, ' ')

function createSearchHistory(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS search_choices (
    query TEXT NOT NULL,file_id INTEGER NOT NULL,last_used INTEGER NOT NULL,uses INTEGER NOT NULL,
    PRIMARY KEY(query,file_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS search_choices_recent ON search_choices(last_used DESC);
    CREATE INDEX IF NOT EXISTS search_choices_file ON search_choices(file_id);
    CREATE TRIGGER IF NOT EXISTS search_files_delete_choices AFTER DELETE ON search_files BEGIN
      DELETE FROM search_choices WHERE file_id=old.rowid;
    END;`)
  const target = database.prepare('SELECT rowid FROM search_files WHERE path=? COLLATE NOCASE')
  const lastChoice = database.prepare('SELECT COALESCE(MAX(last_used),0) AS last FROM search_choices')
  const save = database.prepare(`INSERT INTO search_choices VALUES (?,?,?,1) ON CONFLICT(query,file_id)
    DO UPDATE SET last_used=excluded.last_used,uses=MIN(uses+1,1000000)`)
  const prune = database.prepare(`DELETE FROM search_choices WHERE (query,file_id) IN (
    SELECT query,file_id FROM search_choices ORDER BY last_used DESC LIMIT -1 OFFSET 10000)`)
  function record({ query, path }) {
    const normalized = normalizeQuery(query)
    if (!normalized || normalized.length > 512 || typeof path !== 'string') return false
    const row = target.get(path)
    if (!row) return false
    save.run(normalized, row.rowid, Math.max(Date.now(), Number(lastChoice.get().last) + 1)); prune.run()
    return true
  }
  return { record }
}

function historyReader(database) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='search_choices'").get()) return () => new Map()
  const exact = database.prepare('SELECT * FROM search_choices WHERE query=? ORDER BY last_used DESC')
  const recent = database.prepare('SELECT * FROM search_choices ORDER BY last_used DESC LIMIT 256')
  return query => {
    const normalized = normalizeQuery(query), selected = new Map()
    const cutoff = Date.now() - 90 * 86_400_000
    for (const row of exact.all(normalized)) if (row.last_used >= cutoff) selected.set(row.file_id, { ...row, exact: true })
    for (const row of recent.all()) {
      if (selected.has(row.file_id) || row.last_used < cutoff || !normalized || !row.query) continue
      if (normalized.startsWith(row.query) || row.query.startsWith(normalized)) selected.set(row.file_id, { ...row, exact: false })
    }
    return selected
  }
}

module.exports = { createSearchHistory, historyReader, normalizeQuery }
