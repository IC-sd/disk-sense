const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { pathSignals } = require('./explainer.cjs')
const { normalizeRisk } = require('./risk.cjs')

const fsp = fs.promises
const MAX_RESULTS = 500
const MAX_INDEX_ENTRIES = 3_000_000
const STAT_CONCURRENCY = 32
const PROGRESS_INTERVAL_MS = 180
const CHANGE_DEBOUNCE_MS = 220
const MAX_INCREMENTAL_SUBTREE_ENTRIES = 50_000
const AUTOMATIC_RECONCILE_MS = 12 * 60 * 60 * 1000
// Keep the persisted index immediately searchable on launch. A full reconciliation is
// deliberately deferred and only scheduled for meaningfully stale indexes so short,
// repeated desktop sessions do not continuously rescan every drive.
const STARTUP_RECONCILE_STALE_MS = 2 * 60 * 60 * 1000
const STARTUP_RECONCILE_DELAY_MS = 45 * 1000
const SEARCH_SCHEMA_VERSION = 3

const DOCUMENT_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.txt', '.md',
  '.rtf', '.odt', '.ods', '.odp', '.csv', '.epub'
])
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic', '.raw'
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'
])
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma', '.ape'
])
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.cab', '.iso', '.img'
])
const APPLICATION_EXTENSIONS = new Set(['.exe', '.lnk', '.url', '.appref-ms'])
const INSTALLER_EXTENSIONS = new Set(['.msi', '.msix', '.appx', '.appxbundle'])
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.java', '.kt', '.kts', '.cs',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.rs', '.go', '.php', '.rb', '.swift',
  '.html', '.css', '.scss', '.less', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.sql', '.ps1', '.bat', '.cmd', '.sh'
])

function normalizeRoot(value) {
  const resolved = path.resolve(String(value || ''))
  if (!path.isAbsolute(resolved)) throw new Error('索引范围必须是绝对路径')
  return path.parse(resolved).root || resolved
}

function normalizeTarget(value) {
  const resolved = path.resolve(String(value || ''))
  if (!path.isAbsolute(resolved)) throw new Error('搜索范围必须是绝对路径')
  return resolved
}

function fileKind(name, isDirectory) {
  if (isDirectory) return 'folder'
  const extension = path.extname(name).toLowerCase()
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  if (INSTALLER_EXTENSIONS.has(extension)) return 'installer'
  if (extension === '.exe' && /(?:^|[-_. ])(?:setup|install|installer|uninstall|unins|update)(?:[-_. ]|$)/iu.test(name)) {
    return 'installer'
  }
  if (APPLICATION_EXTENSIONS.has(extension)) return 'application'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  return 'file'
}

function fileStem(name) {
  const value = String(name || '')
  const extension = path.extname(value)
  return extension ? value.slice(0, -extension.length) : value
}

const SEARCH_INTERNAL_PATHS = [
  '\\node_modules\\', '\\site-packages\\', '\\vendor\\', '\\.git\\', '\\.svn\\',
  '\\target\\classes\\', '\\wp-includes\\', '\\dist\\', '\\build\\',
  '\\windows\\winsxs\\', '\\windows\\system32\\', '\\windows\\syswow64\\',
  '\\lib\\', '\\include\\', '\\resources\\', '\\locales\\', '\\packages\\',
  '\\tcl\\tcl', '\\uiresources\\', '\\assets\\images\\', '\\shellnew\\',
  '\\wsxpacks\\', '\\binaries\\python\\', '\\codex-runtimes\\',
  '\\.workbuddy\\plugins\\', '\\plugins\\marketplaces\\', '\\external_plugins\\',
  '\\programdata\\microsoft\\clicktorun\\'
]
const SEARCH_TRANSIENT_PATHS = [
  '\\cache\\', '\\code cache\\', '\\gpucache\\', '\\temp\\', '\\tmp\\',
  '\\logs\\', '\\crashdumps\\', '\\appdata\\local\\packages\\'
]

function searchRanking(item, value, now = Date.now()) {
  const query = String(value || '').trim().toLowerCase()
  if (!query) return { score: 0, priority: 'standard', reason: '名称匹配' }
  const name = String(item.name || '').toLowerCase()
  const rawPath = String(item.path || '')
  const indexedRoot = String(item.root || '')
  const relativePath = indexedRoot && path.isAbsolute(indexedRoot)
    ? path.relative(indexedRoot, rawPath)
    : ''
  const contextualPath = relativePath && !relativePath.startsWith('..')
    ? path.join(path.parse(indexedRoot).root, relativePath)
    : rawPath
  const fullPath = contextualPath.toLowerCase()
  const extension = path.extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  const isDirectory = Boolean(item.is_directory ?? item.isDirectory)
  const kind = String(item.kind || item.searchKind || fileKind(name, isDirectory))
  const isApplication = !isDirectory && ['.exe', '.lnk', '.url', '.appref-ms'].includes(extension)
  const inStartMenu = fullPath.includes('\\start menu\\programs\\')
  const onDesktop = /\\users\\[^\\]+\\(?:onedrive\\)?desktop\\/u.test(fullPath)
  const inProgramFiles = fullPath.includes('\\program files\\')
    || fullPath.includes('\\program files (x86)\\')
  const inUserContent = /\\users\\[^\\]+\\(?:onedrive\\)?(?:desktop|documents|downloads|pictures|videos|music)\\/u.test(fullPath)
  const isInternal = SEARCH_INTERNAL_PATHS.some(part => fullPath.includes(part))
    || (inProgramFiles && !isDirectory && !(isApplication && stem === query))
  const isTransient = SEARCH_TRANSIENT_PATHS.some(part => fullPath.includes(part))
  const exact = stem === query || name === query
  const starts = stem.startsWith(query) || name.startsWith(query)

  // Lexical matching establishes the broad order, then object usefulness tunes
  // that order. An exact dependency file is intentionally allowed to follow a
  // useful matching folder; this is closer to how people search than treating
  // every source-code or package file as equally important.
  let score = 400
  if (stem === query) score = 0
  else if (name === query) score = 1
  else if (stem.startsWith(query)) score = 100
  else if (name.startsWith(query)) score = 102
  else if (stem.includes(query)) score = 200
  else if (name.includes(query)) score = 202
  else if (fullPath.includes(query)) score = 300

  let priority = 'standard'
  let reason = '名称匹配'

  if (isApplication && exact) {
    score -= 34
    priority = 'primary'
    reason = inStartMenu || onDesktop ? '应用入口' : '可运行应用'
  }
  if (inStartMenu) score -= 24
  else if (onDesktop && isApplication) score -= 18
  else if (inProgramFiles && isApplication && exact) score -= 10

  if (isDirectory) {
    score -= exact ? 8 : 18
    if (exact && !isInternal && !isTransient) {
      priority = 'primary'
      reason = '同名文件夹'
    } else if (!isInternal && !isTransient) {
      reason = '文件夹匹配'
    }
  }

  // A bare matching file name is useful, but an application or a clearly named
  // folder is usually the thing a person intended to reach. User documents earn
  // their relevance back below through the personal-content signal.
  if (!isDirectory && !isApplication && exact) score += 86

  if (inUserContent && ['document', 'image', 'video', 'audio', 'archive', 'folder'].includes(kind)) {
    score -= 12
    if (exact || starts) {
      priority = 'primary'
      reason = '个人内容'
    } else {
      reason = '个人内容匹配'
    }
  }

  if (isInternal) {
    score += isDirectory ? (exact ? 30 : 12) : 8
    priority = 'secondary'
    reason = '程序内部文件'
  } else if (isTransient && !(isApplication && exact)) {
    score += 30
    priority = 'secondary'
    reason = '缓存或临时内容'
  } else if (fullPath.includes('\\appdata\\')) {
    score += isDirectory ? 110 : 60
    if (!(isApplication && exact)) {
      priority = 'secondary'
      reason = '应用内部数据'
    }
  }

  const modifiedAt = Number((item.modified_at ?? item.modifiedAt) || 0)
  const ageDays = modifiedAt > 0 ? Math.max(0, now - modifiedAt) / 86_400_000 : Number.POSITIVE_INFINITY
  const recencyBoost = ageDays <= 1 ? 16
    : ageDays <= 7 ? 13
      : ageDays <= 30 ? 10
        : ageDays <= 180 ? 6
          : ageDays <= 365 ? 3
            : 0
  if (!isInternal && !isTransient) {
    const recencyWeight = inUserContent ? 1 : .35
    score -= recencyBoost * recencyWeight
    if (recencyBoost >= 10 && priority === 'standard') reason = '近期匹配'
  }

  const depth = fullPath.split(/[\\/]+/u).filter(Boolean).length
  score += Math.min(depth, 30) * 0.15
  return { score, priority, reason }
}

function searchRelevanceScore(item, value, now = Date.now()) {
  return searchRanking(item, value, now).score
}

function escapeLike(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function hasWildcard(value) {
  return /[*?]/u.test(String(value || ''))
}

function wildcardToLike(value) {
  let pattern = ''
  for (const character of String(value || '')) {
    if (character === '*') pattern += '%'
    else if (character === '?') pattern += '_'
    else pattern += escapeLike(character)
  }
  return pattern
}

function wildcardSearchesPath(value) {
  return /[\\/]/u.test(String(value || '')) || /^[a-z]:/iu.test(String(value || ''))
}

function wildcardKind(value) {
  const matched = /^\*\.([a-z0-9][a-z0-9+_-]{0,15})$/iu.exec(String(value || '').trim())
  if (!matched) return null
  return fileKind(`file.${matched[1]}`, false)
}

function rankAndOrganizeRows(rows, rankingTerm, { sortByRelevance = true } = {}) {
  const rankingCache = new Map()
  const rankingFor = row => {
    let ranking = rankingCache.get(row.path)
    if (!ranking) {
      ranking = searchRanking(row, rankingTerm)
      rankingCache.set(row.path, ranking)
    }
    return ranking
  }
  const orderedRows = [...rows]
  if (sortByRelevance) {
    orderedRows.sort((left, right) => {
      const scoreDifference = rankingFor(left).score - rankingFor(right).score
      if (scoreDifference) return scoreDifference
      const modifiedDifference = Number(right.modified_at) - Number(left.modified_at)
      if (modifiedDifference) return modifiedDifference
      const depthDifference = String(left.path).length - String(right.path).length
      if (depthDifference) return depthDifference
      return String(left.name).localeCompare(String(right.name), undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    })
  }

  const seenApplications = new Set()
  const seenSecondaryExactFolders = new Set()
  const deduplicatedRows = orderedRows.filter(row => {
    if (row.kind === 'application') {
      const extension = path.extname(row.name).toLowerCase()
      if (!APPLICATION_EXTENSIONS.has(extension)) return true
      const identity = fileStem(row.name).trim().toLowerCase()
      if (!identity || seenApplications.has(identity)) return false
      seenApplications.add(identity)
      return true
    }
    if (Boolean(row.is_directory)) {
      const identity = String(row.name || '').trim().toLowerCase()
      const ranking = rankingFor(row)
      if (identity === rankingTerm && ranking.priority === 'secondary') {
        if (seenSecondaryExactFolders.has(identity)) return false
        seenSecondaryExactFolders.add(identity)
      }
    }
    return true
  })

  const prominentRows = []
  const deferredInternalRows = []
  let visibleInternalExactFiles = 0
  let visibleInternalFolders = 0
  for (const row of deduplicatedRows) {
    const stem = fileStem(row.name).toLowerCase()
    const ranking = rankingFor(row)
    if (row.is_directory && ranking.priority === 'secondary') {
      if (visibleInternalFolders >= 2) {
        deferredInternalRows.push(row)
        continue
      }
      visibleInternalFolders++
    }
    if (!row.is_directory && row.kind !== 'application' && stem === rankingTerm && ranking.priority === 'secondary') {
      if (visibleInternalExactFiles >= 1) {
        deferredInternalRows.push(row)
        continue
      }
      visibleInternalExactFiles++
    }
    prominentRows.push(row)
  }
  return {
    rows: [...prominentRows, ...deferredInternalRows],
    rankingFor
  }
}

function uniqueRoots(values) {
  const seen = new Set()
  return values.map(normalizeTarget).filter(root => {
    const key = root.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve))
}

function * chunksOf(items, chunkSize) {
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    yield items.slice(offset, offset + chunkSize)
  }
}

function openSearchDatabase(databasePath) {
  let database = new DatabaseSync(databasePath)
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0)
  const hasExistingIndex = Boolean(database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'search_files'"
  ).get()?.found)
  if (hasExistingIndex && version === 2) {
    database.exec(`
      BEGIN;
      UPDATE search_files
      SET kind = 'application'
      WHERE is_directory = 0 AND (
        lower(name) LIKE '%.exe'
        OR lower(name) LIKE '%.lnk'
        OR lower(name) LIKE '%.url'
        OR lower(name) LIKE '%.appref-ms'
      );
      UPDATE search_files
      SET kind = 'installer'
      WHERE is_directory = 0 AND (
        lower(name) LIKE '%.msi'
        OR lower(name) LIKE '%.msix'
        OR lower(name) LIKE '%.appx'
        OR lower(name) LIKE '%.appxbundle'
        OR lower(name) GLOB '*setup*.exe'
        OR lower(name) GLOB '*installer*.exe'
        OR lower(name) GLOB '*uninstall*.exe'
        OR lower(name) GLOB '*unins*.exe'
      );
      PRAGMA user_version = ${SEARCH_SCHEMA_VERSION};
      COMMIT;
    `)
  } else if (hasExistingIndex && version !== SEARCH_SCHEMA_VERSION) {
    database.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${databasePath}${suffix}`, { force: true }) } catch {}
    }
    database = new DatabaseSync(databasePath)
  }
  return database
}

function createFileSearchService({
  databasePath,
  getVolumeRoots = async () => [],
  onProgress = () => {},
  maximumEntries = MAX_INDEX_ENTRIES,
  watchFactory = fs.watch,
  changeDebounceMs = CHANGE_DEBOUNCE_MS,
  reconcileIntervalMs = AUTOMATIC_RECONCILE_MS
}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = openSearchDatabase(databasePath)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 1500;
    PRAGMA case_sensitive_like = OFF;
    CREATE TABLE IF NOT EXISTS search_files (
      path TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT NOT NULL COLLATE NOCASE,
      root TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL,
      is_directory INTEGER NOT NULL,
      is_link INTEGER NOT NULL,
      size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      generation INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_files_name ON search_files(name);
    CREATE INDEX IF NOT EXISTS search_files_root ON search_files(root);
    CREATE INDEX IF NOT EXISTS search_files_kind ON search_files(kind);
    CREATE INDEX IF NOT EXISTS search_files_modified ON search_files(modified_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      name,
      tokenize = 'trigram'
    );
    CREATE TRIGGER IF NOT EXISTS search_files_delete_fts
    AFTER DELETE ON search_files BEGIN
      DELETE FROM search_fts WHERE rowid = old.rowid;
    END;
    CREATE TABLE IF NOT EXISTS search_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    PRAGMA user_version = ${SEARCH_SCHEMA_VERSION};
  `)

  const statements = {
    upsert: database.prepare(`
      INSERT INTO search_files (
        path, name, root, kind,
        is_directory, is_link, size, modified_at, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        root = excluded.root,
        kind = excluded.kind,
        is_directory = excluded.is_directory,
        is_link = excluded.is_link,
        size = excluded.size,
        modified_at = excluded.modified_at,
        generation = excluded.generation
      RETURNING rowid
    `),
    ftsUpsert: database.prepare(
      'INSERT OR REPLACE INTO search_fts(rowid, name) VALUES (?, ?)'
    ),
    removeStale: database.prepare(
      'DELETE FROM search_files WHERE path LIKE ? ESCAPE \'\\\' AND generation <> ?'
    ),
    findPath: database.prepare(
      'SELECT path, is_directory FROM search_files WHERE path = ? COLLATE NOCASE'
    ),
    removePath: database.prepare(
      'DELETE FROM search_files WHERE path = ? COLLATE NOCASE'
    ),
    removeDescendants: database.prepare(
      'DELETE FROM search_files WHERE path LIKE ? ESCAPE \'\\\''
    ),
    count: database.prepare('SELECT COUNT(*) AS count FROM search_files'),
    metadataGet: database.prepare('SELECT value FROM search_metadata WHERE key = ?'),
    metadataSet: database.prepare(`
      INSERT INTO search_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
  }

  const indexedRows = Number(database.prepare('SELECT COUNT(*) AS count FROM search_files').get()?.count || 0)
  const fullTextRows = Number(database.prepare('SELECT COUNT(*) AS count FROM search_fts').get()?.count || 0)
  if (indexedRows && fullTextRows !== indexedRows) {
    database.exec(`
      DELETE FROM search_fts;
      INSERT INTO search_fts(rowid, name)
      SELECT rowid, name FROM search_files;
    `)
  }

  let active = null
  let closed = false
  const automatic = {
    enabled: false,
    roots: [],
    watchers: new Map(),
    pending: new Map(),
    changeTimer: null,
    processing: null,
    reconcileTimer: null,
    lastChangedAt: null,
    lastError: ''
  }

  function readMetadata(key, fallback = null) {
    try {
      const row = statements.metadataGet.get(key)
      return row ? JSON.parse(row.value) : fallback
    } catch {
      return fallback
    }
  }

  function writeMetadata(key, value) {
    statements.metadataSet.run(key, JSON.stringify(value))
  }

  function countEntries() {
    return Number(statements.count.get()?.count || 0)
  }

  function publicStatus() {
    const saved = readMetadata('status', {})
    const savedAutomatic = readMetadata('automatic', {})
    const running = active?.state
    return {
      available: true,
      indexed: countEntries() > 0,
      building: Boolean(active),
      phase: running?.phase || saved.phase || 'idle',
      roots: running?.roots || saved.roots || [],
      entries: running?.entries ?? countEntries(),
      directories: running?.directories ?? saved.directories ?? 0,
      inaccessible: running?.inaccessible ?? saved.inaccessible ?? 0,
      skippedLinks: running?.skippedLinks ?? saved.skippedLinks ?? 0,
      current: running?.current || '',
      startedAt: running?.startedAt || saved.startedAt || null,
      completedAt: saved.completedAt || null,
      durationMs: running ? Date.now() - running.startedAtMs : saved.durationMs || 0,
      truncated: Boolean(running?.truncated || saved.truncated),
      cancelled: Boolean(saved.cancelled),
      automatic: automatic.enabled,
      watching: automatic.watchers.size > 0,
      watcherCount: automatic.watchers.size,
      pendingChanges: automatic.pending.size,
      lastChangedAt: automatic.lastChangedAt || savedAutomatic.lastChangedAt || null,
      lastError: automatic.lastError || savedAutomatic.lastError || ''
    }
  }

  function publish(state, force = false) {
    const now = Date.now()
    if (!force && now - state.lastProgressAt < PROGRESS_INTERVAL_MS) return
    state.lastProgressAt = now
    onProgress(publicStatus())
  }

  function isDatabaseFile(target) {
    const normalized = target.toLowerCase()
    return (
      normalized === databasePath.toLowerCase()
      || normalized === `${databasePath}-wal`.toLowerCase()
      || normalized === `${databasePath}-shm`.toLowerCase()
    )
  }

  async function inspectTarget(target, root, generation) {
    if (
      isDatabaseFile(target)
    ) return null
    const stat = await fsp.lstat(target)
    const name = path.basename(target)
    const isLink = stat.isSymbolicLink()
    const isDirectory = stat.isDirectory()
    return {
      target,
      row: [
        target,
        name,
        root,
        fileKind(name, isDirectory),
        Number(isDirectory),
        Number(isLink),
        isDirectory ? 0 : Number(stat.size || 0),
        Math.round(Number(stat.mtimeMs || 0)),
        generation
      ],
      traverse: isDirectory && !isLink,
      isLink
    }
  }

  async function inspectEntry(parent, entry, root, generation) {
    try {
      return await inspectTarget(path.join(parent, entry.name), root, generation)
    } catch {
      return null
    }
  }

  function upsertItem(item) {
    const indexed = statements.upsert.get(...item.row)
    statements.ftsUpsert.run(indexed.rowid, item.row[1])
  }

  async function indexRoot(root, generation, state, signal, options = {}) {
    const entryLimit = Math.max(0, Number(options.entryLimit ?? maximumEntries))
    const reportProgress = options.reportProgress !== false
    const queue = [root]
    let queueIndex = 0
    const volumeRoot = normalizeRoot(root)
    while (queueIndex < queue.length && !signal.cancelled && state.entries < entryLimit) {
      const current = queue[queueIndex]
      queueIndex += 1
      state.current = current
      let entries
      try {
        entries = await fsp.readdir(current, { withFileTypes: true })
        state.directories += 1
      } catch {
        state.inaccessible += 1
        if (reportProgress) publish(state)
        continue
      }

      for (const chunk of chunksOf(entries, STAT_CONCURRENCY)) {
        if (signal.cancelled || state.entries >= entryLimit) break
        const inspected = (await Promise.all(
          chunk.map(entry => inspectEntry(current, entry, volumeRoot, generation))
        )).filter(Boolean)
        database.exec('BEGIN')
        try {
          for (const item of inspected) {
            upsertItem(item)
            state.entries += 1
            if (item.traverse) queue.push(item.target)
            if (item.isLink) state.skippedLinks += 1
            if (state.entries >= entryLimit) break
          }
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
        if (reportProgress) publish(state)
        await immediate()
      }
    }
    if (state.entries >= entryLimit) state.truncated = true
  }

  function automaticMetadata() {
    return {
      roots: automatic.roots,
      lastChangedAt: automatic.lastChangedAt,
      lastError: automatic.lastError
    }
  }

  function publishAutomatic() {
    writeMetadata('automatic', automaticMetadata())
    onProgress(publicStatus())
  }

  function removeIndexedTarget(target) {
    const clean = target.replace(/[\\/]+$/, '')
    const prefix = `${clean}${path.sep}`.toLowerCase()
    database.exec('BEGIN')
    try {
      statements.removePath.run(clean)
      statements.removeDescendants.run(`${escapeLike(prefix)}%`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  async function synchronizeTarget(target, root) {
    if (isDatabaseFile(target)) return
    const existing = statements.findPath.get(target)
    const generation = Date.now()
    let item
    try {
      item = await inspectTarget(target, normalizeRoot(root), generation)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        if (existing) removeIndexedTarget(target)
        return
      }
      return
    }
    if (!item) return
    upsertItem(item)
    if (!existing && item.traverse) {
      const remainingCapacity = Math.max(0, maximumEntries - countEntries())
      const state = {
        entries: 0,
        directories: 0,
        inaccessible: 0,
        skippedLinks: 0,
        current: target,
        lastProgressAt: 0,
        truncated: false
      }
      await indexRoot(target, generation, state, { cancelled: false }, {
        entryLimit: Math.min(MAX_INCREMENTAL_SUBTREE_ENTRIES, remainingCapacity),
        reportProgress: false
      })
    }
  }

  function scheduleChangeFlush() {
    if (automatic.changeTimer || closed) return
    automatic.changeTimer = setTimeout(() => {
      automatic.changeTimer = null
      void flushPendingChanges()
    }, changeDebounceMs)
    automatic.changeTimer.unref?.()
  }

  function queueChangedPath(root, filename) {
    if (!automatic.enabled || closed || !filename) return
    const relative = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename)
    if (!relative.trim()) return
    const normalizedRoot = path.resolve(root)
    const target = path.resolve(normalizedRoot, relative)
    const rootPrefix = `${normalizedRoot.replace(/[\\/]+$/, '')}${path.sep}`.toLowerCase()
    if (!target.toLowerCase().startsWith(rootPrefix) || isDatabaseFile(target)) return
    automatic.pending.set(target.toLowerCase(), { target, root: normalizedRoot })
    scheduleChangeFlush()
  }

  async function flushPendingChanges() {
    if (automatic.processing) return automatic.processing
    if (active) {
      scheduleChangeFlush()
      return active.promise
    }
    if (!automatic.pending.size || closed) return publicStatus()
    const batch = [...automatic.pending.values()].sort((left, right) => (
      left.target.length - right.target.length
    ))
    automatic.pending.clear()
    automatic.processing = (async () => {
      for (const change of batch) {
        if (closed) break
        await synchronizeTarget(change.target, change.root)
        await immediate()
      }
      automatic.lastChangedAt = new Date().toISOString()
      if (automatic.watchers.size) automatic.lastError = ''
      publishAutomatic()
      return publicStatus()
    })()
    try {
      return await automatic.processing
    } finally {
      automatic.processing = null
      if (automatic.pending.size) scheduleChangeFlush()
    }
  }

  function closeWatchers() {
    for (const watcher of automatic.watchers.values()) {
      try { watcher.close() } catch {}
    }
    automatic.watchers.clear()
  }

  function scheduleReconcile(delay = reconcileIntervalMs) {
    if (!automatic.enabled || closed || reconcileIntervalMs <= 0) return
    if (automatic.reconcileTimer) clearTimeout(automatic.reconcileTimer)
    automatic.reconcileTimer = setTimeout(async () => {
      automatic.reconcileTimer = null
      if (!automatic.enabled || closed) return
      try {
        const currentRoots = uniqueRoots(await getVolumeRoots())
        const rootsChanged = currentRoots
          .map(root => path.resolve(root).toLowerCase()).sort().join('|')
          !== automatic.roots
            .map(root => path.resolve(root).toLowerCase()).sort().join('|')
        if (rootsChanged && currentRoots.length) {
          automatic.roots = currentRoots
          installWatchers(currentRoots)
        }
        const result = await rebuild({ roots: automatic.roots })
        if (result.started) await waitForIdle()
      } catch (error) {
        automatic.lastError = error instanceof Error ? error.message : String(error)
        publishAutomatic()
      } finally {
        scheduleReconcile()
      }
    }, Math.max(1000, delay))
    automatic.reconcileTimer.unref?.()
  }

  function installWatchers(roots) {
    closeWatchers()
    for (const root of roots) {
      try {
        const watcher = watchFactory(root, { recursive: true, persistent: false }, (_eventType, filename) => {
          queueChangedPath(root, filename)
        })
        watcher.on?.('error', error => {
          automatic.lastError = error instanceof Error ? error.message : String(error)
          try { watcher.close() } catch {}
          automatic.watchers.delete(root.toLowerCase())
          publishAutomatic()
          scheduleReconcile(Math.min(reconcileIntervalMs, 30 * 60 * 1000))
        })
        automatic.watchers.set(root.toLowerCase(), watcher)
      } catch (error) {
        automatic.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    publishAutomatic()
  }

  async function startAutomatic() {
    if (closed) throw new Error('文件搜索服务已经关闭')
    const roots = uniqueRoots(await getVolumeRoots())
    if (!roots.length) throw new Error('没有找到可建立索引的本地磁盘')
    automatic.enabled = true
    automatic.roots = roots
    installWatchers(roots)
    const savedRoots = publicStatus().roots.map(root => path.resolve(root).toLowerCase()).sort()
    const currentRoots = roots.map(root => path.resolve(root).toLowerCase()).sort()
    const rootsChanged = savedRoots.join('|') !== currentRoots.join('|')
    const completedAt = Date.parse(publicStatus().completedAt || '')
    const stale = !Number.isFinite(completedAt) || Date.now() - completedAt >= STARTUP_RECONCILE_STALE_MS
    if (!countEntries() || rootsChanged) await rebuild({ roots })
    const nextReconcile = !countEntries() || rootsChanged || !stale
      ? (automatic.watchers.size ? reconcileIntervalMs : Math.min(reconcileIntervalMs, 30 * 60 * 1000))
      : STARTUP_RECONCILE_DELAY_MS
    scheduleReconcile(nextReconcile)
    return publicStatus()
  }

  function stopAutomatic({ discardPending = false } = {}) {
    automatic.enabled = false
    closeWatchers()
    if (automatic.changeTimer) clearTimeout(automatic.changeTimer)
    if (automatic.reconcileTimer) clearTimeout(automatic.reconcileTimer)
    automatic.changeTimer = null
    automatic.reconcileTimer = null
    if (discardPending) automatic.pending.clear()
  }

  async function waitForIdle() {
    if (active) await active.promise
    if (automatic.changeTimer) {
      clearTimeout(automatic.changeTimer)
      automatic.changeTimer = null
    }
    if (automatic.pending.size) await flushPendingChanges()
    if (automatic.processing) await automatic.processing
    return publicStatus()
  }

  async function rebuild(input = {}) {
    if (active) return { started: false, reason: '已有索引任务正在运行', status: publicStatus() }
    if (automatic.processing) await automatic.processing
    if (automatic.pending.size) await flushPendingChanges()
    if (active) return { started: false, reason: '已有索引任务正在运行', status: publicStatus() }
    const requestedRoots = Array.isArray(input.roots) && input.roots.length
      ? input.roots
      : await getVolumeRoots()
    const roots = uniqueRoots(requestedRoots)
    if (!roots.length) throw new Error('没有找到可建立索引的磁盘')

    const generation = Date.now()
    const signal = { cancelled: false }
    const state = {
      phase: 'building',
      roots,
      entries: 0,
      directories: 0,
      inaccessible: 0,
      skippedLinks: 0,
      current: '',
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      lastProgressAt: 0,
      truncated: false
    }
    const promise = (async () => {
      try {
        for (const root of roots) {
          if (signal.cancelled || state.truncated) break
          await indexRoot(root, generation, state, signal)
        }
        if (!signal.cancelled && !state.truncated) {
          database.exec('BEGIN')
          try {
            for (const root of roots) {
              const prefix = `${root.replace(/[\\/]+$/, '')}${path.sep}`.toLowerCase()
              statements.removeStale.run(`${escapeLike(prefix)}%`, generation)
            }
            database.exec('COMMIT')
          } catch (error) {
            database.exec('ROLLBACK')
            throw error
          }
        }
        const finished = {
          ...state,
          phase: signal.cancelled ? 'cancelled' : state.truncated ? 'partial' : 'ready',
          entries: countEntries(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - state.startedAtMs,
          cancelled: signal.cancelled
        }
        delete finished.startedAtMs
        delete finished.lastProgressAt
        delete finished.current
        writeMetadata('status', finished)
        return finished
      } catch (error) {
        const failed = {
          ...state,
          phase: 'failed',
          entries: countEntries(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - state.startedAtMs,
          cancelled: false,
          error: error instanceof Error ? error.message : String(error)
        }
        delete failed.startedAtMs
        delete failed.lastProgressAt
        writeMetadata('status', failed)
        return failed
      } finally {
        active = null
        onProgress(publicStatus())
        if (automatic.pending.size) scheduleChangeFlush()
      }
    })()
    active = { generation, signal, state, promise }
    publish(state, true)
    return { started: true, generation, status: publicStatus() }
  }

  async function rebuildScope(input = {}) {
    const availableRoots = uniqueRoots(await getVolumeRoots())
    if (!availableRoots.length) throw new Error('没有找到可建立索引的本地磁盘')
    if (input.scope === 'all') return rebuild({ roots: availableRoots })
    const requested = normalizeRoot(input.root || availableRoots[0])
    const matched = availableRoots.find(root => normalizeRoot(root).toLowerCase() === requested.toLowerCase())
    if (!matched) throw new Error('只能为当前可用的本地磁盘建立索引')
    return rebuild({ roots: [matched] })
  }

  function cancel() {
    if (!active) return { cancelled: false }
    active.signal.cancelled = true
    return { cancelled: true, generation: active.generation }
  }

  function search(input = {}) {
    const started = Date.now()
    const rawQuery = String(input.query || '').trim()
    if (!rawQuery) return { items: [], truncated: false, tookMs: 0, index: publicStatus() }
    const query = rawQuery.toLowerCase()
    const scope = ['directory', 'drive', 'all'].includes(input.scope) ? input.scope : 'all'
    const kind = [
      'all', 'folder', 'file', 'application', 'document', 'image', 'video', 'audio', 'archive', 'installer', 'code'
    ].includes(input.kind) ? input.kind : 'all'
    const sort = ['relevance', 'name', 'modified', 'size'].includes(input.sort)
      ? input.sort
      : 'relevance'
    const modified = ['any', 'day', 'week', 'month', 'year'].includes(input.modified)
      ? input.modified
      : 'any'
    const limit = Math.max(1, Math.min(MAX_RESULTS, Number(input.limit || 200)))
    const target = scope === 'all' ? '' : normalizeTarget(input.root || 'C:\\')
    const wildcard = hasWildcard(query)
    const useFullText = !wildcard && [...query].length >= 3
    const source = useFullText
      ? 'search_files AS file JOIN search_fts ON search_fts.rowid = file.rowid'
      : 'search_files AS file'
    let where
    let parameters
    if (useFullText) {
      where = ['search_fts MATCH ?']
      parameters = [`"${query.replaceAll('"', '""')}"`]
    } else if (wildcard) {
      const pattern = wildcardToLike(query)
      if (wildcardSearchesPath(query)) {
        where = ['file.path LIKE ? ESCAPE \'\\\'']
        parameters = [pattern]
      } else {
        where = ['file.name LIKE ? ESCAPE \'\\\'']
        parameters = [pattern]
      }
    } else {
      const pattern = [...query].length <= 2
        ? `${escapeLike(query)}%`
        : `%${escapeLike(query)}%`
      where = ['file.name LIKE ? ESCAPE \'\\\'']
      parameters = [pattern]
    }

    if (scope === 'drive') {
      where.push('file.root = ? COLLATE NOCASE')
      parameters.push(normalizeRoot(target))
    } else if (scope === 'directory') {
      const prefix = `${target.replace(/[\\/]+$/, '')}${path.sep}`
      where.push('(file.path = ? COLLATE NOCASE OR file.path LIKE ? ESCAPE \'\\\')')
      parameters.push(target, `${escapeLike(prefix)}%`)
    }

    const inferredWildcardKind = wildcard && kind === 'all' ? wildcardKind(query) : null
    const effectiveKind = inferredWildcardKind || kind
    if (effectiveKind === 'file') where.push('file.is_directory = 0')
    else if (effectiveKind !== 'all') {
      where.push('file.kind = ?')
      parameters.push(effectiveKind)
    }

    const age = { day: 1, week: 7, month: 30, year: 365 }[modified]
    if (age) {
      where.push('file.modified_at >= ?')
      parameters.push(Date.now() - age * 24 * 60 * 60 * 1000)
    }

    const order = {
      relevance: `
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
      `,
      name: 'file.name ASC, file.path ASC',
      modified: 'file.modified_at DESC, file.name ASC',
      size: 'file.size DESC, file.name ASC'
    }[sort]
    const rankingTerm = query.replaceAll('*', '').replaceAll('?', '') || query
    const orderParameters = sort === 'relevance'
      ? [
          rankingTerm,
          `${escapeLike(rankingTerm)}.%`,
          `${escapeLike(rankingTerm)}%`,
          `%${escapeLike(rankingTerm)}%`
        ]
      : []
    const sql = `
      SELECT file.path, file.name, file.root, file.kind,
        file.is_directory, file.is_link, file.size, file.modified_at
      FROM ${source}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `
    const candidateLimit = sort === 'relevance'
      ? Math.min(MAX_RESULTS * 4, Math.max(limit + 1, Math.ceil(limit * 4)))
      : limit + 1
    const rows = database.prepare(sql).all(...parameters, ...orderParameters, candidateLimit)
    const organizedRows = rankAndOrganizeRows(rows, rankingTerm, { sortByRelevance: sort === 'relevance' })
    const uniqueRows = organizedRows.rows
    const rankingFor = organizedRows.rankingFor
    const truncated = uniqueRows.length > limit || rows.length >= candidateLimit
    const items = uniqueRows.slice(0, limit).map(row => {
      const signal = pathSignals(row.path)
      const isDirectory = Boolean(row.is_directory)
      const ranking = rankingFor(row)
      const extension = isDirectory ? '' : path.extname(row.name).toLowerCase()
      return {
        name: row.name,
        displayName: row.kind === 'application' && ['.lnk', '.url', '.appref-ms'].includes(extension)
          ? fileStem(row.name)
          : row.name,
        path: row.path,
        parent: path.dirname(row.path),
        isDirectory,
        isLink: Boolean(row.is_link),
        size: isDirectory ? null : Number(row.size),
        fileCount: isDirectory ? null : 1,
        sizeEstimated: false,
        modifiedAt: Number(row.modified_at),
        extension,
        searchKind: row.kind,
        searchPriority: ranking.priority,
        relevanceReason: ranking.reason,
        ...signal,
        risk: normalizeRisk(signal.risk)
      }
    })
    return {
      items,
      truncated,
      tookMs: Date.now() - started,
      index: publicStatus()
    }
  }

  async function close() {
    if (closed) return
    stopAutomatic()
    if (active) active.signal.cancelled = true
    await waitForIdle()
    closed = true
    database.close()
  }

  async function checkpoint() {
    stopAutomatic()
    if (active) active.signal.cancelled = true
    await waitForIdle()
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return publicStatus()
  }

  return {
    status: publicStatus,
    startAutomatic,
    stopAutomatic,
    rebuild,
    rebuildScope,
    cancel,
    search,
    checkpoint,
    close,
    waitForIdle
  }
}

module.exports = {
  createFileSearchService,
  fileKind,
  searchRanking,
  searchRelevanceScore,
  rankAndOrganizeRows,
  hasWildcard,
  wildcardToLike,
  wildcardSearchesPath,
  wildcardKind
}
