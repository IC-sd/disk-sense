const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { pathSignals } = require('./explainer.cjs')
const { normalizeRisk } = require('./risk.cjs')
const { createNativeEnumerator } = require('./native-enumerator.cjs')
const { createNtfsIndex } = require('./ntfs-index.cjs')
const { createWordIndex } = require('./search-word-index.cjs')
const { createSearchHistory } = require('./search-history.cjs')

const fsp = fs.promises
const searchNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const MAX_INDEX_ENTRIES = 3_000_000
const STAT_CONCURRENCY = 64
const PROGRESS_INTERVAL_MS = 180
const CHANGE_DEBOUNCE_MS = 220
const MAX_INCREMENTAL_SUBTREE_ENTRIES = 50_000
const AUTOMATIC_RECONCILE_MS = 12 * 60 * 60 * 1000
// Keep the persisted index immediately searchable on launch. A full reconciliation is
// deliberately deferred and only scheduled for meaningfully stale indexes so short,
// repeated desktop sessions do not continuously rescan every drive.
const STARTUP_RECONCILE_STALE_MS = 12 * 60 * 60 * 1000
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

const { fuzzyNameScore, phoneticAliases } = require('./search-query.cjs')
const { createSearchEngine, nameMatchPositions } = require('./search-engine.cjs')

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
  const fuzzyScore = fuzzyNameScore(fileStem(item.name), query)
  if (score === 400 && fuzzyScore !== null) { score = fuzzyScore; reason = '模糊匹配' }

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
    if (recencyBoost >= 10 && priority === 'standard' && reason === '名称匹配') reason = '近期匹配'
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
      return searchNameCollator.compare(String(left.name), String(right.name))
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
    // Rebuild disposable search tables without destroying saved relationship evidence.
    database.exec('DROP TRIGGER IF EXISTS search_files_delete_fts; DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_files; DROP TABLE IF EXISTS search_metadata; DROP TABLE IF EXISTS search_gaps;')
  }
  return database
}

function presentSearchResult(result, input, index, started = Date.now()) {
  const presentationStarted = performance.now()
  const items = result.rows.map(row => {
    const signal = pathSignals(row.path)
    const isDirectory = Boolean(row.is_directory)
    const ranking = searchRanking(row, result.parsed.text)
    const extension = isDirectory ? '' : path.extname(row.name).toLowerCase()
    const displayName = row.kind === 'application' && ['.lnk', '.url', '.appref-ms'].includes(extension) ? fileStem(row.name) : row.name
    const match = nameMatchPositions(displayName, result.parsed, row.kind === 'application')
    return {
      name: row.name, displayName, path: row.path, parent: path.dirname(row.path),
      isDirectory, isLink: Boolean(row.is_link), size: isDirectory ? null : Number(row.size),
      fileCount: isDirectory ? null : 1, sizeEstimated: false, modifiedAt: Number(row.modified_at), extension,
      searchKind: row.kind, searchPriority: ranking.priority,
      relevanceReason: row.selectionReason || (match.phonetic ? '拼音匹配' : match.fuzzy ? '模糊匹配' : ranking.reason),
      matchPositions: match.positions, matchTitle: displayName,
      ...signal, risk: normalizeRisk(signal.risk)
    }
  })
  result.diagnostics.stages.presentation = performance.now() - presentationStarted
  return {
    items, sessionId: result.sessionId, total: result.total, offset: result.offset,
    nextOffset: result.nextOffset, truncated: result.nextOffset !== null,
    tookMs: Date.now() - started, index, diagnostics: result.diagnostics
  }
}

function createFileSearchService({
  databasePath,
  getVolumeRoots = async () => [],
  onProgress = () => {},
  maximumEntries = MAX_INDEX_ENTRIES,
  nativeEnumeration = process.platform === 'win32',
  searchCancellation,
  searchCacheMs,
  ntfsClientFactory,
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
    PRAGMA cache_size = -65536;
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
    CREATE INDEX IF NOT EXISTS search_directory_names ON search_files(name,path) WHERE is_directory=1;
    CREATE TABLE IF NOT EXISTS search_phonetics (
      path TEXT NOT NULL COLLATE NOCASE, alias TEXT NOT NULL COLLATE NOCASE,
      initials TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(path,alias)
    );
    CREATE INDEX IF NOT EXISTS search_phonetic_alias ON search_phonetics(alias);
    CREATE INDEX IF NOT EXISTS search_phonetic_initials ON search_phonetics(initials);
    CREATE TRIGGER IF NOT EXISTS search_files_delete_phonetics AFTER DELETE ON search_files BEGIN
      DELETE FROM search_phonetics WHERE path=old.path;
    END;
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
    CREATE TABLE IF NOT EXISTS search_gaps (
      path TEXT PRIMARY KEY COLLATE NOCASE,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_scan_queue (
      generation INTEGER NOT NULL, path TEXT NOT NULL COLLATE NOCASE,
      root TEXT NOT NULL, priority INTEGER NOT NULL,
      PRIMARY KEY(generation, path)
    );
    CREATE INDEX IF NOT EXISTS search_scan_priority ON search_scan_queue(generation, priority);
    CREATE TABLE IF NOT EXISTS search_scan_seen (
      generation INTEGER NOT NULL, path TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY(generation, path)
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
    `),
    ftsUpsert: database.prepare(
      'INSERT OR REPLACE INTO search_fts(rowid, name) VALUES (?, ?)'
    ),
    touch: database.prepare('UPDATE search_files SET generation=? WHERE rowid=?'),
    metadataUpdate: database.prepare('UPDATE search_files SET size=?,modified_at=?,generation=? WHERE rowid=?'),
    removeStale: database.prepare(`DELETE FROM search_files WHERE path LIKE ? ESCAPE '\\' AND generation <> ?
      AND NOT EXISTS (SELECT 1 FROM search_gaps gap WHERE search_files.path = gap.path COLLATE NOCASE
        OR lower(substr(search_files.path, 1, length(gap.path) + 1)) = lower(gap.path || ?))`),
    gapSet: database.prepare('INSERT OR REPLACE INTO search_gaps VALUES (?, ?)'),
    gapRemove: database.prepare('DELETE FROM search_gaps WHERE path = ? COLLATE NOCASE'),
    gapFind: database.prepare('SELECT reason FROM search_gaps WHERE path = ? COLLATE NOCASE'),
    gapsRemoveTree: database.prepare(`DELETE FROM search_gaps WHERE path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\'`),
    findPath: database.prepare(
      'SELECT rowid, path, name, root, kind, is_directory, is_link, size, modified_at, generation FROM search_files WHERE path = ? COLLATE NOCASE'
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
  let indexedEntryCount = indexedRows
  const fullTextRows = Number(database.prepare('SELECT COUNT(*) AS count FROM search_fts').get()?.count || 0)
  if (indexedRows && fullTextRows !== indexedRows) {
    database.exec(`
      DELETE FROM search_fts;
      INSERT INTO search_fts(rowid, name)
      SELECT rowid, name FROM search_files;
    `)
  }

  let active = null
  let indexRevision = 0
  const savedGeneration = readMetadata('generationSeed')
  let generationSeed = Number.isSafeInteger(savedGeneration) && savedGeneration >= 0 ? savedGeneration
    : Number(database.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM search_files').get().generation)
  writeMetadata('generationSeed', generationSeed)
  const nextGeneration = () => {
    generationSeed = Math.max(Date.now(), generationSeed + 1)
    // Persist before use so a restart does not scan every file to allocate a generation.
    writeMetadata('generationSeed', generationSeed)
    return generationSeed
  }
  let closed = false
  let nativeScanner = null
  let scannerAttempted = false
  let scannerKind = 'portable'
  let stopping = false
  let enriching = false
  let ntfsTimer = null, ntfsProcessing = null
  const wordIndex = createWordIndex(database, { shouldStop: () => stopping || closed,
    changed: () => { indexRevision++; onProgress(publicStatus()) } })
  const searchHistory = createSearchHistory(database)
  const searchEngine = createSearchEngine(database, { revision: () => indexRevision, cancellation: searchCancellation, wordIndexReady: wordIndex.ready, cacheMs: searchCacheMs })
  const aliasRemove = database.prepare('DELETE FROM search_phonetics WHERE path=? COLLATE NOCASE')
  const aliasInsert = database.prepare('INSERT OR IGNORE INTO search_phonetics VALUES (?,?,?)')
  function indexPhonetics(target, name) {
    aliasRemove.run(target)
    for (const { alias, initials } of phoneticAliases(name)) aliasInsert.run(target, alias, initials)
  }
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

  const ntfs = createNtfsIndex({
    database, cacheDirectory: path.join(path.dirname(databasePath), 'search-native-cache'),
    maximumEntries, clientFactory: ntfsClientFactory,
    upsertItem, removeTarget: target => removeIndexedTarget(target, { deferCount: true }), isDatabaseFile,
    finalizeRoot(root, generation) {
      statements.removeStale.run(`${escapeLike(root.replace(/[\\/]+$/, '') + path.sep)}%`, generation, path.sep)
      recountEntries()
      indexRevision++
    },
    progress: state => publish(state),
    changed(changes = false) {
      if (changes) {
        indexRevision++
        automatic.lastChangedAt = new Date().toISOString()
        recountEntries()
      }
      onProgress(publicStatus())
    }
  })

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
    return indexedEntryCount
  }

  function recountEntries() {
    indexedEntryCount = Number(statements.count.get()?.count || 0)
    return indexedEntryCount
  }

  function publicStatus() {
    const saved = readMetadata('status', {})
    const savedAutomatic = readMetadata('automatic', {})
    const running = active?.state
    return {
      available: true,
      indexed: countEntries() > 0,
      building: Boolean(active),
      synchronizing: Boolean(automatic.processing || ntfsProcessing || ntfs.status().synchronizing),
      revision: indexRevision,
      coverageVersion: running?.coverageVersion || saved.coverageVersion || 0,
      phase: running?.phase || saved.phase || 'idle',
      roots: running?.roots || saved.roots || [],
      entries: countEntries(),
      scannedEntries: running?.entries || 0,
      scanner: scannerKind,
      ntfs: ntfs.status(),
        nativeStage: running?.nativeStage || null,
      enriching,
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
    if (active) writeMetadata('scan', { generation: active.generation, state: { ...state } })
    onProgress(publicStatus())
  }

  function isDatabaseFile(target) {
    const normalized = target.toLowerCase()
    return (
      normalized === databasePath.toLowerCase()
      || normalized === `${databasePath}-wal`.toLowerCase()
      || normalized === `${databasePath}-shm`.toLowerCase()
      || normalized === path.join(path.dirname(databasePath), 'search-native-cache').toLowerCase()
      || normalized.startsWith(`${path.join(path.dirname(databasePath), 'search-native-cache').toLowerCase()}${path.sep}`)
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
    } catch (error) {
      statements.gapSet.run(path.join(parent, entry.name), String(error?.code || 'stat-failed'))
      indexRevision++
      return { inaccessible: true }
    }
  }

  function upsertItem(item) {
    if (item.ntfs) item.row[3] = fileKind(item.row[1], Boolean(item.row[4]))
    const previous = statements.findPath.get(item.target)
    const sameIdentity = previous && previous.name === item.row[1] && previous.root === item.row[2] && previous.kind === item.row[3]
      && previous.is_directory === item.row[4] && previous.is_link === item.row[5]
    if (sameIdentity && previous.size === item.row[6] && previous.modified_at === item.row[7]) {
      if (item.touchGeneration !== false) statements.touch.run(item.row[8], previous.rowid)
      statements.gapRemove.run(item.target)
      return
    }
    if (sameIdentity) {
      statements.metadataUpdate.run(item.row[6], item.row[7], item.touchGeneration === false ? previous.generation : item.row[8], previous.rowid)
      statements.gapRemove.run(item.target)
      indexRevision++
      return
    }
    const indexed = statements.upsert.run(...item.row)
    if (!previous) indexedEntryCount++
    if (!previous || previous.name !== item.row[1]) statements.ftsUpsert.run(previous?.rowid ?? indexed.lastInsertRowid, item.row[1])
    if (!previous || previous.name !== item.row[1]) indexPhonetics(item.target, item.row[1])
    if (!previous || previous.name !== item.row[1]) wordIndex.index(previous?.rowid ?? indexed.lastInsertRowid, item.row[1])
    statements.gapRemove.run(item.target)
    indexRevision++
  }

  async function indexRoot(root, generation, state, signal, options = {}) {
    const entryLimit = Math.max(0, Number(options.entryLimit ?? maximumEntries))
    const reportProgress = options.reportProgress !== false
    const volumeRoot = normalizeRoot(root)
    const enqueue = database.prepare(`INSERT OR IGNORE INTO search_scan_queue(generation,path,root,priority)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM search_scan_seen WHERE generation=? AND path=? COLLATE NOCASE)`)
    const next = database.prepare('SELECT path FROM search_scan_queue WHERE generation=? AND root=? COLLATE NOCASE ORDER BY priority,rowid LIMIT 1')
    const done = database.prepare('INSERT OR IGNORE INTO search_scan_seen VALUES (?,?)')
    const remove = database.prepare('DELETE FROM search_scan_queue WHERE generation=? AND path=? COLLATE NOCASE')
    const priority = target => /[\\/](?:node_modules|\.git|\.cache|\.npm|\.pnpm-store|codex-runtimes|appdata|windows|program files(?: \(x86\))?|\$recycle\.bin)(?:[\\/]|$)/iu.test(target) ? 10 : 0
    const add = (target, preferred = false) => enqueue.run(generation, target, root, preferred ? -10 : priority(target), generation, target)
    add(root)
    // Seed user folders and application shortcuts before traversing system/package trees.
    if (path.resolve(root).toLowerCase() === volumeRoot.toLowerCase()) {
      for (const base of [process.env.USERPROFILE, process.env.PUBLIC, process.env.ProgramData]) {
        if (!base || normalizeRoot(base).toLowerCase() !== volumeRoot.toLowerCase()) continue
        const suffixes = base === process.env.ProgramData ? ['Microsoft/Windows/Start Menu/Programs']
          : ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs']
        for (const suffix of suffixes) {
          const target = path.join(base, suffix)
          try {
            // Do not reach a seeded directory through an ancestor junction.
            let current = target, linked = false
            while (current !== volumeRoot) {
              if ((await fsp.lstat(current)).isSymbolicLink()) { linked = true; break }
              const parent = path.dirname(current)
              if (parent === current) break
              current = parent
            }
            if (!linked) add(target, true)
          } catch { /* optional known folder */ }
        }
      }
    }
    if (nativeEnumeration && !scannerAttempted) {
      scannerAttempted = true
      try {
        nativeScanner = await createNativeEnumerator(path.join(path.dirname(databasePath), 'search-native-cache'))
        if (nativeScanner) scannerKind = 'windows-native'
      }
      catch { /* portable enumeration also works without a .NET compiler */ }
    }
    if (!nativeScanner) scannerKind = 'portable'
    async function *enumerate(current) {
      if (nativeScanner) {
        yield* nativeScanner.enumerate(current)
        return
      }
      const entries = await fsp.readdir(current, { withFileTypes: true })
      for (const chunk of chunksOf(entries, STAT_CONCURRENCY)) {
        const inspected = (await Promise.all(chunk.map(entry => inspectEntry(current, entry, volumeRoot, generation)))).filter(Boolean)
        yield { inspected, done: false }
      }
      yield { inspected: [], done: true }
    }
    while (!signal.cancelled && state.entries < entryLimit) {
      const queued = next.get(generation, root)
      if (!queued) break
      const current = queued.path
      state.current = current
      try {
        let directoryError = false
        for await (const batch of enumerate(current)) {
          if (signal.cancelled || state.entries >= entryLimit) break
          const inspected = batch.inspected || batch.rows.map(([name, attributes, size, modified]) => {
            const target = path.join(current, name)
            if (isDatabaseFile(target)) return null
            const isDirectory = Boolean(attributes & 16), isLink = Boolean(attributes & 1024)
            return { target, row: [target, name, volumeRoot, fileKind(name, isDirectory), Number(isDirectory), Number(isLink), isDirectory ? 0 : size, modified, generation], traverse: isDirectory && !isLink, isLink }
          }).filter(Boolean)
          database.exec('BEGIN')
          try {
            for (const item of inspected) {
              if (item.inaccessible) { state.inaccessible++; continue }
              upsertItem(item)
              state.entries++
              if (item.traverse) add(item.target)
              if (item.isLink) state.skippedLinks++
              if (state.entries >= entryLimit) break
            }
            if (batch.error) {
              statements.gapSet.run(current, `enumeration-${batch.error}`)
              state.inaccessible++
              directoryError = true
            }
            if (batch.done) {
              if (!directoryError) statements.gapRemove.run(current)
              done.run(generation, current)
              remove.run(generation, current)
              state.directories++
            }
            database.exec('COMMIT')
          } catch (error) { database.exec('ROLLBACK'); throw error }
          if (reportProgress) publish(state)
          await immediate()
        }
      } catch (error) {
        if (error?.code === 'NATIVE_ENUMERATOR_FAILED') {
          nativeScanner?.close()
          nativeScanner = null
          scannerKind = 'portable'
          continue
        }
        statements.gapSet.run(current, String(error?.code || 'read-failed'))
        done.run(generation, current)
        remove.run(generation, current)
        indexRevision++
        state.inaccessible += 1
        if (reportProgress) publish(state)
      }
    }
    if (signal.cancelled || state.entries >= entryLimit) { nativeScanner?.close(); nativeScanner = null; scannerAttempted = false }
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

  function removeIndexedTarget(target, { deferCount = false } = {}) {
    const clean = target.replace(/[\\/]+$/, '')
    const prefix = `${clean}${path.sep}`.toLowerCase()
    database.exec('SAVEPOINT search_remove_target')
    try {
      statements.removePath.run(clean)
      statements.removeDescendants.run(`${escapeLike(prefix)}%`)
      statements.gapsRemoveTree.run(clean, `${escapeLike(prefix)}%`)
      indexRevision++
      database.exec('RELEASE search_remove_target')
      if (!deferCount) recountEntries()
    } catch (error) {
      database.exec('ROLLBACK TO search_remove_target; RELEASE search_remove_target')
      throw error
    }
  }

  async function synchronizeTarget(target, root) {
    if (isDatabaseFile(target)) return
    const existing = statements.findPath.get(target)
    const hasGap = Boolean(statements.gapFind.get(target))
    const generation = nextGeneration()
    let item
    try {
      item = await inspectTarget(target, normalizeRoot(root), generation)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        if (existing) removeIndexedTarget(target)
        return
      }
      statements.gapSet.run(target, String(error?.code || 'stat-failed'))
      indexRevision++
      return
    }
    if (!item) return
    upsertItem(item)
    if ((!existing || hasGap) && item.traverse) {
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
      if (state.truncated) statements.gapSet.run(target, 'entry-limit')
      else {
        statements.removeStale.run(`${escapeLike(target.replace(/[\\/]+$/, '') + path.sep)}%`, generation, path.sep)
        indexRevision++
        recountEntries()
      }
      database.prepare('DELETE FROM search_scan_queue WHERE generation=?').run(generation)
      database.prepare('DELETE FROM search_scan_seen WHERE generation=?').run(generation)
      nativeScanner?.close()
      nativeScanner = null
      scannerAttempted = false
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
    if (ntfs.usable(root)) return
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
          await ntfs.prepare(currentRoots)
          installWatchers(currentRoots)
        }
        if (ntfs.status().active) await synchronizeNtfs()
        const fallback = automatic.roots.filter(root => !ntfs.usable(root) || !ntfs.hasSnapshot(root))
        if (fallback.length) {
          const result = await rebuild({ roots: fallback })
          if (result.started) await waitForIdle()
        }
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
      if (ntfs.usable(root)) continue
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
    const nativeReady = await ntfs.prepare(roots)
    installWatchers(roots)
    const savedRoots = publicStatus().roots.map(root => path.resolve(root).toLowerCase()).sort()
    const currentRoots = roots.map(root => path.resolve(root).toLowerCase()).sort()
    const rootsChanged = savedRoots.join('|') !== currentRoots.join('|')
    const completedAt = Date.parse(publicStatus().completedAt || '')
    const stale = !Number.isFinite(completedAt) || Date.now() - completedAt >= STARTUP_RECONCILE_STALE_MS
    const interrupted = readMetadata('scan')
    const allNativeComplete = nativeReady && roots.every(root => ntfs.usable(root) && ntfs.hasSnapshot(root))
    if (allNativeComplete && interrupted) {
      // A completed native snapshot supersedes an old directory-scan checkpoint.
      writeMetadata('scan', null)
      database.exec('DELETE FROM search_scan_queue; DELETE FROM search_scan_seen;')
      writeMetadata('status', { ...readMetadata('status', {}), phase: 'ready', cancelled: false })
    }
    const needsNativeSnapshot = nativeReady && roots.some(root => ntfs.usable(root) && !ntfs.hasSnapshot(root))
    if (!countEntries() || rootsChanged || (interrupted && !allNativeComplete) || needsNativeSnapshot) await rebuild({ roots, resume: true })
    else if (nativeReady) await synchronizeNtfs()
    // Reuse the persisted index immediately. Age alone never starts a full scan
    // 45 seconds after every launch; watchers maintain it between scheduled audits.
    const nextReconcile = automatic.watchers.size ? reconcileIntervalMs
      : Math.min(reconcileIntervalMs, stale ? 5 * 60 * 1000 : 30 * 60 * 1000)
    scheduleReconcile(nextReconcile)
    scheduleNtfs()
    return publicStatus()
  }

  function scheduleNtfs() {
    if (!automatic.enabled || closed || ntfsTimer || !ntfs.status().active) return
    ntfsTimer = setTimeout(() => {
      ntfsTimer = null
      void synchronizeNtfs().catch(error => { automatic.lastError = error.message; publishAutomatic() }).finally(scheduleNtfs)
    }, 2000)
    ntfsTimer.unref?.()
  }

  async function synchronizeNtfs() {
    if (ntfsProcessing) return ntfsProcessing
    if (active || automatic.processing || !ntfs.status().active || closed) return
    ntfsProcessing = (async () => {
      let reset = false
      for (const root of automatic.roots) {
        if (!ntfs.usable(root) || !ntfs.hasSnapshot(root)) continue
        const result = await ntfs.replay(root, nextGeneration())
        if (result.reset) reset = true
      }
      if (reset && !closed) return { reset: true }
      scannerKind = 'ntfs-usn'
      return { reset: false }
    })()
    let result
    try { result = await ntfsProcessing } finally { ntfsProcessing = null }
    if (result?.reset && !active && !stopping && automatic.enabled) {
      // A changed/wrapped journal cannot be treated as a successfully applied delta.
      await rebuild({ roots: automatic.roots, resume: true })
    }
  }

  async function enableNtfs() {
    if (active) { active.signal.cancelled = true; await active.promise }
    if (ntfsProcessing) await ntfsProcessing
    if (automatic.processing) await automatic.processing
    const roots = uniqueRoots(await getVolumeRoots())
    if (ntfsTimer) clearTimeout(ntfsTimer)
    ntfsTimer = null
    let ready
    try { ready = await ntfs.prepare(roots, { elevate: true }) }
    catch (error) {
      // Cancelling a Windows prompt must not leave automatic synchronization paused.
      await ntfs.prepare(roots)
      installWatchers(roots)
      scheduleNtfs()
      throw error
    }
    if (!ready) throw new Error('当前磁盘无法启用 NTFS 加速')
    automatic.enabled = true
    automatic.roots = roots
    automatic.pending.clear()
    installWatchers(roots)
    let result
    if (roots.every(root => ntfs.usable(root) && ntfs.hasSnapshot(root))) {
      // Reauthorizing an existing index only needs the saved journal cursor.
      statements.metadataSet.run('scan', 'null')
      database.exec('DELETE FROM search_scan_queue; DELETE FROM search_scan_seen;')
      await synchronizeNtfs()
      if (!active) writeMetadata('status', { ...readMetadata('status', {}), phase: 'ready', cancelled: false, roots })
      result = { started: Boolean(active), status: publicStatus() }
    } else result = await rebuild({ roots })
    scheduleNtfs()
    return result
  }

  async function disableNtfs() {
    if (active) { active.signal.cancelled = true; await active.promise }
    if (ntfsProcessing) await ntfsProcessing
    if (automatic.processing) await automatic.processing
    if (ntfsTimer) clearTimeout(ntfsTimer)
    ntfsTimer = null
    try {
      await ntfs.uninstall()
      await startAutomatic()
      return { started: false, status: publicStatus() }
    } finally { scheduleNtfs() }
  }

  function stopAutomatic({ discardPending = false } = {}) {
    automatic.enabled = false
    closeWatchers()
    if (automatic.changeTimer) clearTimeout(automatic.changeTimer)
    if (automatic.reconcileTimer) clearTimeout(automatic.reconcileTimer)
    if (ntfsTimer) clearTimeout(ntfsTimer)
    ntfsTimer = null
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
    if (ntfsProcessing) await ntfsProcessing
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

    const checkpoint = input.resume ? readMetadata('scan') : null
    const resumable = !roots.some(root => ntfs.usable(root))
      && checkpoint?.state?.roots?.map(root => path.resolve(root).toLowerCase()).sort().join('|')
      === roots.map(root => path.resolve(root).toLowerCase()).sort().join('|')
      && database.prepare('SELECT 1 FROM search_scan_queue WHERE generation=? LIMIT 1').get(checkpoint?.generation || 0)
    const generation = resumable ? checkpoint.generation : nextGeneration()
    if (!resumable) {
      database.exec('DELETE FROM search_scan_queue; DELETE FROM search_scan_seen;')
    }
    const signal = { cancelled: false }
    const reusedNativeRoots = new Set()
    const state = {
      phase: 'building',
      roots,
      entries: resumable ? checkpoint.state.entries : 0,
      directories: resumable ? checkpoint.state.directories : 0,
      inaccessible: resumable ? checkpoint.state.inaccessible : 0,
      skippedLinks: resumable ? checkpoint.state.skippedLinks : 0,
      current: '',
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      lastProgressAt: 0,
      coverageVersion: 1,
      truncated: false
    }
    const promise = (async () => {
      try {
        for (const root of roots) {
          if (signal.cancelled || state.truncated) break
          if (!resumable) statements.gapsRemoveTree.run(root.replace(/[\\/]+$/, ''), `${escapeLike(root.replace(/[\\/]+$/, '') + path.sep)}%`)
          let usedNative = false
          if (ntfs.usable(root)) {
            if (input.resume && ntfs.hasSnapshot(root)) {
              const replayed = await ntfs.replay(root, generation)
              if (replayed.used && !replayed.reset) {
                reusedNativeRoots.add(root)
                usedNative = true
                const counts = database.prepare('SELECT COUNT(*) AS entries,COALESCE(SUM(is_directory),0) AS directories FROM search_files WHERE root=? COLLATE NOCASE').get(root)
                state.entries += Number(counts.entries); state.directories += Number(counts.directories)
              }
            }
            if (!usedNative) {
              scannerKind = 'ntfs-mft'
              usedNative = await ntfs.snapshot(root, generation, state, signal)
            }
          }
          if (!usedNative && !signal.cancelled) await indexRoot(root, generation, state, signal)
        }
        if (!signal.cancelled && !state.truncated) {
          database.exec('BEGIN')
          try {
            for (const root of roots) {
              if (reusedNativeRoots.has(root)) continue
              const prefix = `${root.replace(/[\\/]+$/, '')}${path.sep}`.toLowerCase()
              statements.removeStale.run(`${escapeLike(prefix)}%`, generation, path.sep)
            }
            database.exec('COMMIT')
            recountEntries()
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
        if (!signal.cancelled && !state.truncated) {
          statements.metadataSet.run('scan', 'null')
          database.exec('DELETE FROM search_scan_queue; DELETE FROM search_scan_seen;')
        } else writeMetadata('scan', signal.explicit || state.truncated ? null : { generation, state })
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
        nativeScanner?.close()
        nativeScanner = null
        scannerAttempted = false
        active = null
        scheduleNtfs()
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
    active.signal.explicit = true
    return { cancelled: true, generation: active.generation }
  }

  function search(input = {}) {
    const started = Date.now()
    if (!String(input.query || '').trim()) return { items: [], truncated: false, tookMs: 0, index: publicStatus() }
    const inferredKind = wildcardKind(String(input.query || '').trim())
    const result = searchEngine.search({ ...input, inferredKind })
    return presentSearchResult(result, input, publicStatus(), started)
  }

  async function close() {
    if (closed) return
    stopping = true
    stopAutomatic()
    if (active) active.signal.cancelled = true
    await waitForIdle()
    await enrichmentTask
    await wordEnrichmentTask
    ntfs.close()
    closed = true
    database.close()
  }

  async function checkpoint() {
    stopping = true
    stopAutomatic()
    if (active) active.signal.cancelled = true
    await waitForIdle()
    await enrichmentTask
    await wordEnrichmentTask
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return publicStatus()
  }

  // Enrich an existing index in small resumable batches. This never turns a
  // usable index into a blocking full rebuild just to add pinyin support.
  const enrichmentTask = (async () => {
    if (!indexedRows || readMetadata('phonetics')?.complete) return
    enriching = true
    let cursor = readMetadata('phonetics')?.cursor || 0
    const batchQuery = database.prepare("SELECT rowid,path,name FROM search_files WHERE rowid>? AND name GLOB '*[㐀-鿿]*' ORDER BY rowid LIMIT 128")
    while (!stopping) {
      await immediate()
      if (stopping) break
      const batch = batchQuery.all(cursor)
      if (!batch.length) { writeMetadata('phonetics', { cursor, complete: true }); break }
      database.exec('BEGIN')
      try {
        for (const row of batch) indexPhonetics(row.path, row.name)
        cursor = batch.at(-1).rowid
        writeMetadata('phonetics', { cursor, complete: false })
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
      indexRevision++
      automatic.lastChangedAt = new Date().toISOString()
      publishAutomatic()
    }
    enriching = false
  })().catch(error => { enriching = false; automatic.lastError = String(error.message || error) })
  const wordEnrichmentTask = wordIndex.start().catch(error => { automatic.lastError = String(error.message || error) })

  return {
    status: publicStatus,
    startAutomatic,
    enableNtfs,
    disableNtfs,
    stopAutomatic,
    rebuild,
    rebuildScope,
    cancel,
    search,
    recordSelection(input) { const recorded = searchHistory.record(input); if (recorded) indexRevision++; return { recorded } },
    checkpoint,
    close,
    waitForIdle,
    waitForQueryIndex: () => wordEnrichmentTask
  }
}

module.exports = {
  createFileSearchService,
  presentSearchResult,
  fileKind,
  searchRanking,
  searchRelevanceScore,
  rankAndOrganizeRows,
  hasWildcard,
  wildcardToLike,
  wildcardSearchesPath,
  wildcardKind
}
