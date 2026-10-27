const { abbreviationTokens } = require('./search-query.cjs')

// Contentless pair postings narrow word/camel abbreviation candidates.
// It narrows abbreviation candidates without traversing every filename per keypress.
function createWordIndex(database, { shouldStop = () => false, changed = () => {} } = {}) {
  database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_abbreviations USING fts5(
    grams,content='',contentless_delete=1,detail='none');
    DROP TRIGGER IF EXISTS search_files_delete_words;
    CREATE TRIGGER search_files_delete_words AFTER DELETE ON search_files BEGIN
      DELETE FROM search_abbreviations WHERE rowid=old.rowid;
    END;
    DROP TABLE IF EXISTS search_word_starts;`)
  const insert = database.prepare('INSERT OR REPLACE INTO search_abbreviations(rowid,grams) VALUES (?,?)')
  const get = database.prepare("SELECT value FROM search_metadata WHERE key='wordIndex'")
  const save = database.prepare("INSERT INTO search_metadata VALUES ('wordIndex',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  let state
  try { state = JSON.parse(get.get()?.value || 'null') } catch {}
  if (state?.version !== 3) state = { version: 3, cursor: 0, complete: false }
  function index(id, name) { insert.run(id, abbreviationTokens(name)) }
  let task
  function start() {
    return task ||= (async () => {
      const batch = database.prepare('SELECT rowid,name FROM search_files WHERE rowid>? ORDER BY rowid LIMIT 1000')
      while (!state.complete && !shouldStop()) {
        await new Promise(resolve => setImmediate(resolve))
        if (shouldStop()) break
        const rows = batch.all(state.cursor)
        database.exec('BEGIN')
        try {
          for (const row of rows) index(row.rowid, row.name)
          const nextState = { version: 3, cursor: rows.length ? rows.at(-1).rowid : state.cursor, complete: rows.length === 0 }
          save.run(JSON.stringify(nextState))
          database.exec('COMMIT')
          state = nextState
        } catch (error) { database.exec('ROLLBACK'); throw error }
      }
      if (state.complete) changed()
    })()
  }
  return { index, start, ready: () => state.complete }
}

module.exports = { createWordIndex }
