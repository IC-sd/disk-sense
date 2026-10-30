const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { parseSearchQuery, fuzzyPattern, matchName, createAbbreviationMatcher, abbreviationQuery } = require('./search-query.cjs')
const { historyReader } = require('./search-history.cjs')
const { createCandidateSet, createCandidateView, indexCandidates } = require('./search-candidate-session.cjs')
const { createSessionCache } = require('./search-session-cache.cjs')
const { createDiskSession, orderKey, locationScore } = require('./search-disk-session.cjs')

const escapeLike = value => String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
const fields = 'file.rowid AS id, file.path, file.name, file.root, file.kind, file.is_directory, file.is_link, file.size, file.modified_at'
const candidateFields = 'file.rowid AS id, file.path, file.name, file.kind, file.is_directory, file.size, file.modified_at'

function createSearchEngine(database, { profile = () => {}, revision = () => 0, cacheMs = 15_000, cancellation, wordIndexReady,
  incrementalReuse = true, sessionMaxBytes = 64 * 1024 * 1024, readOnlySource = false } = {}) {
  if (!Number.isSafeInteger(sessionMaxBytes) || sessionMaxBytes < 1) throw new RangeError('sessionMaxBytes must be a positive integer')
  database.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-4096;')
  const hasWordIndex = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name='search_abbreviations'").get())
  const indexState = hasWordIndex ? database.prepare("SELECT value FROM search_metadata WHERE key='wordIndex'") : null
  const wordsReady = wordIndexReady || (() => { try { const state = JSON.parse(indexState?.get()?.value || 'null'); return state?.version === 3 && state.complete } catch { return false } })
  const cancellationVersion = cancellation ? new Int32Array(cancellation) : null
  const matchScores = new Map()
  let expectedVersion = 0
  function assertActive() {
    if (cancellationVersion && Atomics.load(cancellationVersion, 0) !== expectedVersion) {
      const error = new Error('搜索请求已被更新的关键词替代')
      error.code = 'SEARCH_SUPERSEDED'
      throw error
    }
    return 0
  }
  database.function('disk_search_active', assertActive)
  database.function('disk_search_order_key', { deterministic: true }, orderKey)
  database.function('disk_search_location', { deterministic: true }, locationScore)
  database.function('disk_search_fold', { deterministic: true }, value => value.toLowerCase())
  database.function('disk_search_length', { deterministic: true }, value => value.length)
  database.function('disk_search_title', { deterministic: true }, value => {
    const key = value.toLowerCase()
    return key.slice(0, key.endsWith('.appref-ms') ? -10 : -4)
  })
  const matchScore = (name, query, partial) => {
    const key = `${query}\0${partial}\0${name}`
    if (matchScores.has(key)) return matchScores.get(key)
    const score = matchName(name, query, { allowPartial: Boolean(partial), scoreOnly: true })?.score ?? 10000
    if (matchScores.size < 8192) matchScores.set(key, score)
    return score
  }
  database.function('disk_search_match', { deterministic: true }, matchScore)
  database.function('disk_search_rank', { deterministic: true }, (name, file, term, partial) => {
    const key = name.toLowerCase()
    return key === term || key.startsWith(term + '.') ? 0 : key.startsWith(term) ? 100
      : key.includes(term) ? 200 : file.toLowerCase().includes(term) ? 300 : matchScore(name, term, partial)
  })
  const sessions = createSessionCache({ maxBytes: sessionMaxBytes, dispose: session => session.candidates.close?.(), estimate: (session, accounting) => {
    if (session.candidates.disk) return 0 // only bounded session metadata remains in JS
    let bytes = 512 + (session.key.length + session.scopeKey.length + session.query.length) * 2
    if (!accounting.objects.has(session.candidates)) {
      accounting.objects.add(session.candidates)
      bytes += session.candidates.estimatedBytes(accounting)
    }
    for (const view of session.views.values()) bytes += view.estimatedBytes(accounting)
    return bytes + (session.rankingChoices?.size || 0) * 128
  } })
  const dataVersion = database.prepare('PRAGMA data_version')
  const totalChanges = database.prepare('SELECT total_changes() AS value')
  // A read-only source cannot change through this connection. Its temporary
  // candidate tables must not invalidate the source fingerprint themselves.
  const fingerprint = () => JSON.stringify([revision(), dataVersion.get().data_version,
    readOnlySource ? 0 : totalChanges.get().value, database.isTransaction])
  function readSnapshot(operation) {
    database.exec('SAVEPOINT disk_search_recall')
    try {
      const value = operation()
      database.exec('RELEASE disk_search_recall')
      return value
    } catch (error) {
      try { database.exec('ROLLBACK TO disk_search_recall; RELEASE disk_search_recall') } catch {}
      throw error
    }
  }
  const remembered = historyReader(database)
  const fold = value => value.toLowerCase()
  // Wide recall fetches thousands of equally sized ID batches. Prepare that
  // SQL once instead of reparsing a 500-placeholder query for every batch.
  const batchStatements = new Map()
  function batchStatement(columns, count) {
    const key = `${columns === candidateFields ? 'candidate' : 'page'}:${count}`
    let statement = batchStatements.get(key)
    if (!statement) {
      statement = database.prepare(`SELECT ${columns} FROM search_files AS file WHERE file.rowid IN (${Array(count).fill('?').join(',')})`)
      if (batchStatements.size >= 32) batchStatements.delete(batchStatements.keys().next().value)
      batchStatements.set(key, statement)
    }
    return statement
  }

  function termIds(term, allowPartial) {
    const pattern = `%${escapeLike(term)}%`
    if (/[\\/]/u.test(term)) {
      const segments = term.split(/[\\/]+/u).filter(Boolean)
      const pathPattern = `%${segments.map(escapeLike).join(`%${escapeLike(path.sep)}%`)}%`
      return { sql: "SELECT rowid FROM search_files WHERE path LIKE ? ESCAPE '\\'", parameters: [pathPattern] }
    }
    const fullText = [...term].length >= 3
    const nameSql = fullText
      ? 'SELECT rowid FROM search_fts WHERE search_fts MATCH ?'
      : "SELECT rowid FROM search_files WHERE name LIKE ? ESCAPE '\\'"
    const nameParameters = [fullText ? `"${term.replaceAll('"', '""')}"` : pattern]
    const directories = fullText
      ? `search_fts CROSS JOIN search_files AS directory ON directory.rowid=search_fts.rowid`
      : `search_files AS directory INDEXED BY search_directory_names`
    const directoryWhere = fullText ? 'search_fts MATCH ?' : "directory.name LIKE ? ESCAPE '\\'"
    // Match directory components independently of filenames. The range join uses
    // the path primary key, rather than scanning every full path for each query.
    const separatorEnd = String.fromCharCode(path.sep.charCodeAt(0) + 1)
    return {
      sql: `${nameSql}
        UNION SELECT child.rowid FROM ${directories} CROSS JOIN search_files AS child
          ON child.path >= directory.path || ? COLLATE NOCASE
          AND child.path < directory.path || ? COLLATE NOCASE
          WHERE directory.is_directory=1 AND ${directoryWhere}
        UNION SELECT file.rowid FROM search_phonetics AS phonetic CROSS JOIN search_files AS file ON file.path=phonetic.path
          WHERE (phonetic.alias LIKE ? ESCAPE '\\' OR phonetic.initials LIKE ? ESCAPE '\\')
            AND disk_search_match(file.name,?,?)<10000`,
      parameters: [...nameParameters, path.sep, separatorEnd, ...nameParameters, pattern, pattern, term, Number(allowPartial)]
    }
  }

  function search(input = {}) {
    const lifetime = { disk: null }
    try { return runSearch(input, lifetime) }
    finally { lifetime.disk?.close() }
  }

  function runSearch(input, lifetime) {
    const searchStarted = performance.now()
    const diagnostics = { stages: {}, counts: {}, reusedSession: false }
    const record = (stage, duration, details) => {
      diagnostics.stages[stage] = (diagnostics.stages[stage] || 0) + duration
      if (details) diagnostics.counts[stage] = details
      profile(stage, duration, details)
    }
    expectedVersion = input._searchVersion ?? (cancellationVersion ? Atomics.load(cancellationVersion, 0) : 0)
    assertActive()
    let stageStarted = performance.now()
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)))
    const requestedOffset = Math.max(0, Math.floor(Number(input.offset) || 0))
    // Sorting projects the same matching session; it is not a recall condition.
    const scopeKey = JSON.stringify([input.scope, input.root, input.kind, input.modified, input.inferredKind])
    const key = JSON.stringify([input.query, scopeKey])
    // A caller can roll back and open another transaction without changing
    // total_changes(). Never cache uncommitted candidate data across queries.
    const inCallerTransaction = database.isTransaction
    const currentFingerprint = inCallerTransaction ? null : fingerprint()
    const sort = ['name', 'modified', 'size'].includes(input.sort) ? input.sort : 'relevance'
    let session = input.sessionId && sessions.get(input.sessionId)
    if (!session && cacheMs > 0 && currentFingerprint !== null) session = sessions.find(value => value.key === key && value.fingerprint === currentFingerprint && Date.now() - value.createdAt < cacheMs)
    let offset = requestedOffset
    if (!session || session.key !== key) {
      matchScores.clear()
      offset = 0
      const parsed = parseSearchQuery(input.query)
      if (!parsed.terms.length && !parsed.extensions.length && !parsed.kind) return { rows: [], sessionId: '', total: 0, offset: 0, nextOffset: null, parsed, diagnostics }
      const query = parsed.text.toLowerCase()
      const wildcard = /[*?]/u.test(query)
      const where = [], parameters = []
      if (wildcard) {
        let pattern = ''
        const pathMode = /[\\/]/u.test(query)
        for (const character of pathMode ? query.replaceAll('/', path.sep) : query) pattern += character === '*' ? '%' : character === '?' ? '_' : escapeLike(character)
        if (pathMode && !path.isAbsolute(query)) pattern = `%${pattern}`
        where.push(`file.${/[\\/]/u.test(query) ? 'path' : 'name'} LIKE ? ESCAPE '\\'`)
        parameters.push(pattern)
      } else {
        // Start with the longest indexed word; other words remain independent AND conditions.
        const terms = [...parsed.terms].sort((a, b) => b.length - a.length)
        for (const term of terms) {
          const ids = termIds(term, parsed.allowPartial)
          where.push(`file.rowid IN (${ids.sql})`)
          parameters.push(...ids.parameters)
        }
      }
      const lexicalCount = where.length
      const lexicalParameterCount = parameters.length
      if (input.scope === 'drive') { where.push('file.root=? COLLATE NOCASE'); parameters.push(path.parse(path.resolve(input.root || 'C:\\')).root) }
      else if (input.scope === 'directory') {
        const root = path.resolve(input.root || 'C:\\').replace(/[\\/]+$/u, '')
        where.push("(file.path=? COLLATE NOCASE OR file.path LIKE ? ESCAPE '\\')")
        parameters.push(root, `${escapeLike(root + path.sep)}%`)
      }
      let kind = parsed.kind || input.kind || 'all'
      if (wildcard && kind === 'all' && /^\*\.[a-z0-9]+$/iu.test(query)) kind = input.inferredKind || kind
      if (kind === 'file') where.push('file.is_directory=0')
      else if (kind !== 'all') { where.push('file.kind=?'); parameters.push(kind) }
      if (parsed.extensions.length) {
        where.push(`file.is_directory=0 AND (${parsed.extensions.map(() => "file.name LIKE ? ESCAPE '\\'").join(' OR ')})`)
        parameters.push(...parsed.extensions.map(extension => `%.${escapeLike(extension)}`))
      }
      const days = { day: 1, week: 7, month: 30, year: 365 }[input.modified]
      if (days) { where.push('file.modified_at>=?'); parameters.push(Date.now() - days * 86_400_000) }
      const constraints = where.slice(lexicalCount)
      const constraintParameters = parameters.slice(lexicalParameterCount)
      const fuzzy = !wildcard && parsed.terms.length === 1 ? fuzzyPattern(query) : null
      const active = cancellationVersion ? ' AND disk_search_active()=0' : ''
      const term = query.replaceAll('*', '').replaceAll('?', '')
      const context = input.root ? fold(path.resolve(input.root).replace(/[\\/]+$/u, '')) : ''
      let candidates, sourceFingerprint, fetchStats
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = fingerprint()
        const source = incrementalReuse && !inCallerTransaction && attempt === 0 ? sessions.find(value => value.key !== key && value.scopeKey === scopeKey
          && value.fingerprint === before && Date.now() - value.createdAt < 15_000) : null
        const previous = source?.candidates.disk ? null : source?.candidates
        if (previous) { indexCandidates(previous, assertActive); sessions.refresh(source.id, { pin: true }) }
        const result = readSnapshot(() => {
          const recallStarted = performance.now()
          // Always execute complete recall. Prefix filtering of prior matches is
          // unsound across LIKE/trigram, pinyin and provider-mode transitions.
          const ids = new Set()
          let spool = null, estimated = 0
          const fetchIds = batch => batchStatement(candidateFields, batch.length).all(...batch)
          const spill = () => {
            spool = createDiskSession(database, { context, term, partial: Number(parsed.allowPartial),
              choices: remembered(input.query), matchScore, assertActive })
            lifetime.disk = spool
            const pending = [...ids]
            for (let offset = 0; offset < pending.length; offset += 256) {
              for (const row of fetchIds(pending.slice(offset, offset + 256))) spool.add(row)
              assertActive()
            }
            ids.clear()
          }
          const add = row => {
            if (spool) { spool.add(row); return }
            if (ids.has(row.id)) return
            ids.add(row.id)
            // Reserve ranking, views and the worst-case ID map as well as text.
            estimated += 1024 + 8 * (row.path.length + row.name.length)
            if (estimated > Math.min(sessionMaxBytes / 2, 16 * 1024 * 1024)) spill()
          }
          try {
            const recallSql = `SELECT ${candidateFields} FROM search_files AS file WHERE ${where.join(' AND ') || '1=1'}${active}`
            for (const row of database.prepare(recallSql).iterate(...parameters)) {
              add(row); assertActive()
              if (spool) break
            }
            if (spool) spool.addQuery(recallSql, parameters)
            if (fuzzy) {
              const fuzzyWhere = ["file.kind='application'", "file.name LIKE ? ESCAPE '\\'", ...constraints]
              const fuzzySql = `SELECT ${candidateFields} FROM search_files AS file WHERE ${fuzzyWhere.join(' AND ')}${active}`
              if (spool) spool.addQuery(fuzzySql, [fuzzy, ...constraintParameters])
              else for (const row of database.prepare(fuzzySql).iterate(fuzzy, ...constraintParameters)) add(row)
              const pairQuery = abbreviationQuery(query), indexed = wordsReady() && Boolean(pairQuery)
              const matches = createAbbreviationMatcher(query)
              const abbreviationWhere = ["file.name LIKE ? ESCAPE '\\'", ...constraints]
              if (spool) abbreviationWhere.push(spool.missingSql('file'))
              const abbreviationParameters = [fuzzy, ...constraintParameters]
              if (indexed) {
                abbreviationWhere.push('file.rowid IN (SELECT rowid FROM search_abbreviations WHERE search_abbreviations MATCH ?)')
                abbreviationParameters.push(pairQuery)
              }
              for (const row of database.prepare(`SELECT ${candidateFields} FROM search_files AS file WHERE ${abbreviationWhere.join(' AND ')}${active}`).iterate(...abbreviationParameters)) {
                if (!spool && ids.has(row.id)) continue
                if (matches(row.name)) add(row)
                assertActive()
              }
            }
          } catch (error) { spool?.close(); throw error }
          if (spool) return { candidates: spool, fetched: spool.count, reused: 0,
            fetchMs: 0, recallMs: performance.now() - recallStarted, columnsMs: 0 }
          const recallMs = performance.now() - recallStarted
          // Copy only selected columns and used names. Small refinements never
          // retain a parent snapshot's large typed-array backing storage.
          const order = [...ids], missing = [], rows = new Map()
          for (const id of order) if (!previous?.idIndex.has(id)) missing.push(id)
          const fetchStarted = performance.now()
          for (let start = 0; start < missing.length; start += 500) {
            const batch = missing.slice(start, start + 500)
            for (const row of batchStatement(candidateFields, batch.length).all(...batch)) rows.set(row.id, row)
            assertActive()
          }
          const fetchMs = performance.now() - fetchStarted
          const columnsStarted = performance.now()
          const candidates = createCandidateSet(rows, { context, assertActive, ids: order, previous })
          return { candidates, fetched: missing.length, reused: order.length - missing.length,
            fetchMs, recallMs, columnsMs: performance.now() - columnsStarted }
        })
        const after = fingerprint()
        // A writer may commit between the version check and acquiring the read
        // snapshot. Discard mixed reuse and retry once without cached metadata.
        if (result.reused && before !== after) continue
        candidates = result.candidates; fetchStats = result
        sourceFingerprint = !inCallerTransaction && before === after ? after : null
        break
      }
      assertActive()
      record('recall', fetchStats.recallMs, { candidates: candidates.count })
      record('fetch', fetchStats.fetchMs, { count: fetchStats.fetched })
      record('columns', fetchStats.columnsMs, { count: candidates.count })
      if (candidates.disk) record('storage', 0, { mode: 'disk', candidates: candidates.count })
      if (fetchStats.reused) record('reuse', performance.now() - stageStarted, { reused: fetchStats.reused, fetched: fetchStats.fetched })
      session = { id: randomUUID(), key, scopeKey, query, parsed, term, candidates, views: new Map(), fingerprint: sourceFingerprint,
        createdAt: Date.now(), revision: revision(), rankingChoices: null }
      record('materialize', performance.now() - stageStarted)
      assertActive()
      if (sessions.set(session.id, session, { pin: true })) lifetime.disk = null
    } else diagnostics.reusedSession = true
    stageStarted = performance.now()
    if (session.candidates.disk) {
      const view = session.candidates.view(sort)
      const page = view.page(offset, limit)
      record('page', performance.now() - stageStarted)
      record('cache', 0, sessions.stats())
      diagnostics.candidates = session.candidates.count
      diagnostics.returned = page.rows.length
      diagnostics.tookMs = performance.now() - searchStarted
      return { ...page, sessionId: session.id, total: view.total, offset, parsed: session.parsed, diagnostics }
    }
    let view = session.views.get(sort)
    if (!view) {
      // Explicit field ordering never computes fuzzy relevance. A relevance
      // view freezes its history context, including when a cancelled merge
      // subsequently needs to rebuild this view from the same candidate set.
      if (sort === 'relevance' && !session.rankingChoices) session.rankingChoices = remembered(input.query)
      view = createCandidateView(session.candidates, sort, { term: session.term, partial: Number(session.parsed.allowPartial),
        choices: session.rankingChoices, matchScore, assertActive, profile: record })
      assertActive()
      session.views.set(sort, view)
      record('deduplicate', performance.now() - stageStarted)
    }
    // Under byte pressure retain the active ordering, not several large views.
    sessions.refresh(session.id, { pin: true })
    if (sessions.stats().overBudget && session.views.size > 1) {
      for (const previousSort of session.views.keys()) if (previousSort !== sort) session.views.delete(previousSort)
      sessions.refresh(session.id, { pin: true })
    }
    stageStarted = performance.now()
    let cursor = offset
    const rows = []
    try {
      while (rows.length < limit && cursor < view.total) {
        const batch = view.range(cursor, Math.min(view.total, cursor + limit - rows.length))
        const ids = Array.from(batch, ordinal => session.candidates.ids[ordinal])
        const live = new Map(batchStatement(fields, ids.length).all(...ids).map(row => [row.id, row]))
        for (const ordinal of batch) {
          cursor++
          const row = live.get(session.candidates.ids[ordinal])
          if (row && fold(row.path) === session.candidates.paths[ordinal]) {
            row.selectionReason = view.recent?.[ordinal] ? '最近使用' : undefined
            rows.push(row)
          }
        }
        assertActive()
      }
      assertActive()
    } catch (error) {
      // A cancelled incremental merge may have advanced its private cursors.
      // Recreate it from the unchanged snapshot rather than reuse partial state.
      session.views.delete(sort)
      sessions.refresh(session.id, { pin: true })
      throw error
    }
    sessions.refresh(session.id, { pin: true })
    record('cache', 0, sessions.stats())
    record('page', performance.now() - stageStarted)
    diagnostics.candidates = session.candidates.count
    diagnostics.returned = rows.length
    diagnostics.tookMs = performance.now() - searchStarted
    return { rows, sessionId: session.id, total: view.total, offset, nextOffset: cursor < view.total && rows.length ? cursor : null, parsed: session.parsed, diagnostics }
  }
  return { search, close: () => sessions.clear(), cacheStats: () => sessions.stats() }
}

function nameMatchPositions(name, parsed, preferBoundaries = false) {
  const positions = new Set()
  let phonetic = false, fuzzy = false
  for (const term of parsed.terms) {
    const result = matchName(name, term, { allowPartial: parsed.allowPartial, preferBoundaries })
    if (!result) continue
    result.positions.forEach(position => positions.add(position))
    phonetic ||= result.kind === 'pinyin'
    fuzzy ||= result.kind === 'fuzzy'
  }
  return { positions: [...positions].sort((a, b) => a - b), phonetic, fuzzy }
}

module.exports = { createSearchEngine, nameMatchPositions }
