const path = require('node:path')
const { topPage } = require('./search-top-page.cjs')
let sequence = 0

// UTF-16 big-endian keys reproduce JavaScript's string ordering, including
// supplementary characters; SQLite's default UTF-8 ordering is different.
function orderKey(value) {
  const buffer = Buffer.from(value.toLowerCase(), 'utf16le')
  buffer.swap16()
  return buffer
}

function locationScore(file, context) {
  const key = file.toLowerCase()
  let score = /\\(?:node_modules|appdata|windows|lib)\\/u.test(key) ? 32 : 0
  if (key.includes('\\start menu\\programs\\')) score -= 24
  if (context && path.dirname(file).toLowerCase() === context) score -= 20
  else if (context && key.startsWith(context + path.sep)) score -= 6
  return score
}

function createDiskSession(database, { context, term, partial, choices, matchScore, assertActive }) {
  const table = `disk_candidates_${++sequence}`
  const views = new Map()
  let count = 0, ranked = false, keysReady = false, closed = false
  database.exec(`CREATE TEMP TABLE ${table} (
    id INTEGER PRIMARY KEY,path TEXT NOT NULL,path_key BLOB,name_key BLOB,
    name TEXT,title TEXT,application INTEGER,directory INTEGER,size REAL,modified REAL,path_length INTEGER,
    score REAL DEFAULT 0,recent INTEGER DEFAULT 0,chosen REAL DEFAULT 0)`)
  const insert = database.prepare(`INSERT OR IGNORE INTO ${table}(id,path,path_key,name_key,name,title,application,directory,size,modified,path_length,score)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
  function add(row) {
    const key = row.name.toLowerCase()
    const location = locationScore(row.path, context)
    const application = Number(row.kind === 'application')
    count += Number(insert.run(row.id, row.path, orderKey(row.path), orderKey(row.name), row.name,
      application ? key.slice(0, key.endsWith('.appref-ms') ? -10 : -4) : null,
      application, row.is_directory, row.size, row.modified_at, row.path.length,
      location + (application ? -34 : row.is_directory ? -8 : 0)).changes)
  }
  function batches(action) {
    const next = database.prepare(`SELECT id FROM ${table} WHERE id>? ORDER BY id LIMIT 1 OFFSET 511`)
    const last = database.prepare(`SELECT max(id) AS id FROM ${table} WHERE id>?`)
    let cursor = -Number.MAX_SAFE_INTEGER
    while (true) {
      const upper = next.get(cursor)?.id ?? last.get(cursor)?.id
      if (upper == null) break
      action(cursor, upper)
      cursor = upper
      assertActive()
    }
  }
  function fillKeys() {
    if (keysReady) return
    const update = database.prepare(`UPDATE ${table} SET path_key=disk_search_order_key(path),name_key=disk_search_order_key(name),
      title=CASE WHEN application=1 THEN substr(disk_search_fold(name),1,length(name)-CASE WHEN name LIKE '%.appref-ms' THEN 10 ELSE 4 END) ELSE NULL END,
      path_length=disk_search_length(path),score=score+disk_search_location(path,?) + CASE WHEN application=1 THEN -34 ELSE 0 END
      WHERE id>? AND id<=? AND path_key IS NULL`)
    // Return to JS between batches so native SQLite callbacks cannot retain
    // an entire query's temporary strings/Buffers before V8 can collect them.
    batches((lower, upper) => update.run(context, lower, upper))
    keysReady = true
  }
  function rank() {
    if (ranked) return
    const score = database.prepare(`UPDATE ${table} SET score=score+disk_search_rank(name,path,?,?) WHERE id>? AND id<=? AND disk_search_active()=0`)
    batches((lower, upper) => score.run(term, partial, lower, upper))
    const update = database.prepare(`UPDATE ${table} SET score=score-?,recent=?,chosen=? WHERE id=?`)
    for (const [id, choice] of choices) {
      update.run(choice.exact ? 0 : 16, Number(Boolean(choice.exact)), choice.exact ? choice.last_used : 0, id)
      assertActive()
    }
    ranked = true
  }
  function view(sort) {
    if (views.has(sort)) return views.get(sort)
    const name = `${table}_${sort}`
    const identity = 'path_key,id'
    const relevance = `recent DESC,chosen DESC,score,modified DESC,path_length,name_key,${identity}`
    const order = sort === 'name' ? `name_key,${identity}` : sort === 'size' ? `size DESC,${identity}`
      : sort === 'modified' ? `modified DESC,${identity}` : relevance
    let total = count, indexed = false, prefix = null
    if (sort === 'relevance') {
      const applications = database.prepare(`SELECT count(*) AS count,count(DISTINCT disk_search_title(name)) AS titles FROM ${table} WHERE application=1`).get()
      total += Number(applications.titles) - Number(applications.count)
    }
    function prepareIndex() {
      if (indexed) return
      database.exec('SAVEPOINT disk_session_view')
      const wasRanked = ranked, hadKeys = keysReady
      try {
        fillKeys()
        if (sort === 'relevance') {
          rank()
          database.exec(`CREATE TEMP TABLE ${table}_applications AS SELECT id FROM (
            SELECT id,row_number() OVER (PARTITION BY title ORDER BY ${relevance}) AS duplicate
            FROM ${table} WHERE application=1) WHERE duplicate=1`)
          database.exec(`CREATE UNIQUE INDEX ${table}_applications_id ON ${table}_applications(id)`)
        }
        database.exec(`CREATE INDEX ${name}_order ON ${table}(${order})`)
        database.exec('RELEASE disk_session_view')
        indexed = true
      } catch (error) {
        ranked = wasRanked; keysReady = hadKeys
        database.exec('ROLLBACK TO disk_session_view; RELEASE disk_session_view')
        throw error
      }
    }
    function hydrate(snapshot) {
      if (!snapshot.length) return []
      const ids = snapshot.map(row => row.id)
      const live = new Map(database.prepare(`SELECT rowid AS id,* FROM search_files WHERE rowid IN (${ids.map(() => '?').join(',')})`)
        .all(...ids).map(row => [row.id, row]))
      const rows = []
      for (const item of snapshot) {
        const row = live.get(item.id)
        if (row && row.path.toLowerCase() === item.path.toLowerCase()) {
          row.selectionReason = item.recent ? '最近使用' : undefined
          rows.push(row)
        }
      }
      return rows
    }
    const result = { total, page(offset, limit) {
      if (!indexed && offset + limit <= 2048) {
        // Stream the frozen snapshot into a bounded heap. The first screen
        // needs no full metadata rewrite, full ranking table or sorting index.
        if (!prefix || prefix.length < Math.min(offset + limit, total)) {
          prefix = topPage(database.prepare(`SELECT id,path,name,application,directory,size,modified FROM ${table}`).iterate(),
            offset + limit, sort, { context, term, partial, choices, matchScore, locationScore, assertActive })
        }
        const snapshot = prefix.slice(offset, offset + limit)
        const rows = hydrate(snapshot)
        if (rows.length === snapshot.length) return { rows, nextOffset: offset + rows.length < total ? offset + rows.length : null }
        // Concurrent deletion of a top result needs the complete order to
        // refill the page and advance its cursor consistently.
      }
      prepareIndex()
      const filter = sort === 'relevance' ? ` AND (application=0 OR id IN (SELECT id FROM ${table}_applications))` : ''
      const read = database.prepare(`SELECT id,path,recent FROM ${table} INDEXED BY ${name}_order
        WHERE disk_search_active()=0${filter} ORDER BY ${order} LIMIT ? OFFSET ?`)
      let cursor = offset
      const rows = []
      while (rows.length < limit && cursor < total) {
        const snapshot = read.all(limit - rows.length, cursor)
        if (!snapshot.length) break
        cursor += snapshot.length
        rows.push(...hydrate(snapshot))
        assertActive()
      }
      return { rows, nextOffset: cursor < total && rows.length ? cursor : null }
    } }
    views.set(sort, result)
    return result
  }
  return { disk: true, add, view,
    missingSql: alias => `NOT EXISTS (SELECT 1 FROM ${table} recalled WHERE recalled.id=${alias}.rowid)`,
    addQuery(sql, parameters) {
      const result = database.prepare(`INSERT OR IGNORE INTO ${table}(id,path,name,application,directory,size,modified,path_length,score)
        SELECT id,path,name,kind='application',is_directory,size,modified_at,0,CASE WHEN is_directory=1 AND kind<>'application' THEN -8 ELSE 0 END
        FROM (${sql})`).run(...parameters)
      count += Number(result.changes)
      assertActive()
    },
    get count() { return count }, estimatedBytes: () => 0,
    close() {
      if (closed) return
      database.exec(`DROP TABLE IF EXISTS ${table}_applications`)
      database.exec(`DROP TABLE IF EXISTS ${table}`)
      closed = true
    } }
}

module.exports = { createDiskSession, orderKey, locationScore }
