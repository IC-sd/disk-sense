const path = require('node:path').win32
const { randomUUID } = require('node:crypto')
const { createNtfsClient, removePersistentNtfsService } = require('./ntfs-client.cjs')

const localRoot = value => /^[a-z]:\\$/iu.test(String(value || ''))
const like = value => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
const identity = value => typeof value === 'string' && /^\d{1,20}$/u.test(value)

function createNtfsIndex({ database, cacheDirectory, upsertItem, removeTarget, finalizeRoot,
  isDatabaseFile, changed, progress, maximumEntries, clientFactory = createNtfsClient }) {
  database.exec(`CREATE TABLE IF NOT EXISTS search_ntfs_volumes (
    root TEXT PRIMARY KEY COLLATE NOCASE,serial TEXT NOT NULL,journal_id TEXT NOT NULL,
    next_usn TEXT NOT NULL,root_id TEXT NOT NULL,complete INTEGER NOT NULL,last_synced TEXT);
    CREATE TABLE IF NOT EXISTS search_ntfs_links (
      root TEXT NOT NULL COLLATE NOCASE,ref TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,
      path TEXT NOT NULL COLLATE NOCASE,attributes INTEGER NOT NULL,PRIMARY KEY(root,path));
    CREATE INDEX IF NOT EXISTS search_ntfs_ref ON search_ntfs_links(root,ref);
    CREATE INDEX IF NOT EXISTS search_ntfs_parent ON search_ntfs_links(root,parent);
    CREATE TABLE IF NOT EXISTS search_ntfs_snapshot_stage (
      root TEXT NOT NULL COLLATE NOCASE,path TEXT NOT NULL COLLATE NOCASE,
      ref TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,attributes INTEGER NOT NULL,
      size INTEGER NOT NULL,modified INTEGER NOT NULL,PRIMARY KEY(root,path));
    CREATE TABLE IF NOT EXISTS search_ntfs_replays (
      root TEXT PRIMARY KEY COLLATE NOCASE,serial TEXT NOT NULL,journal_id TEXT NOT NULL,
      from_usn TEXT NOT NULL,to_usn TEXT NOT NULL,generation INTEGER NOT NULL,
      phase TEXT NOT NULL,position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS search_ntfs_replay_changes (
      root TEXT NOT NULL COLLATE NOCASE,position INTEGER NOT NULL,payload TEXT NOT NULL,
      PRIMARY KEY(root,position));
    DELETE FROM search_ntfs_snapshot_stage;`)
  const volumeGet = database.prepare('SELECT * FROM search_ntfs_volumes WHERE root=? COLLATE NOCASE')
  const volumeSave = database.prepare(`INSERT OR REPLACE INTO search_ntfs_volumes VALUES (?,?,?,?,?,?,?)`)
  const linkSave = database.prepare(`INSERT INTO search_ntfs_links VALUES (?,?,?,?,?,?)
    ON CONFLICT(root,path) DO UPDATE SET ref=excluded.ref,parent=excluded.parent,name=excluded.name,path=excluded.path,attributes=excluded.attributes
    WHERE ref<>excluded.ref OR parent<>excluded.parent OR name<>excluded.name OR path<>excluded.path COLLATE BINARY OR attributes<>excluded.attributes`)
  const linksFor = database.prepare('SELECT * FROM search_ntfs_links WHERE root=? COLLATE NOCASE AND ref=?')
  const linksRemove = database.prepare('DELETE FROM search_ntfs_links WHERE root=? COLLATE NOCASE AND path=? COLLATE NOCASE')
  const linksRemoveDescendants = database.prepare("DELETE FROM search_ntfs_links WHERE root=? COLLATE NOCASE AND path LIKE ? ESCAPE '\\'")
  const statements = new Map()
  const replayGet = database.prepare('SELECT * FROM search_ntfs_replays WHERE root=? COLLATE NOCASE')
  const replayProgress = database.prepare('UPDATE search_ntfs_replays SET phase=?,position=? WHERE root=? COLLATE NOCASE')
  const replayDiscard = root => {
    database.prepare('DELETE FROM search_ntfs_replay_changes WHERE root=? COLLATE NOCASE').run(root)
    database.prepare('DELETE FROM search_ntfs_replays WHERE root=? COLLATE NOCASE').run(root)
  }
  let client = null, enabled = false, requiresElevation = false, lastError = '', closing = false, busy = false
  let lastPublication = null
  const rootsAvailable = new Set(), failedRoots = new Set()

  function saveVolume(root, state, complete) {
    volumeSave.run(root, state.serial, state.journalId || state.journal_id, state.nextUsn || state.next_usn,
      state.rootId || state.root_id, Number(complete), new Date().toISOString())
  }
  function status() {
    return {
      active: enabled && [...rootsAvailable].some(root => !failedRoots.has(root)), persistent: Boolean(client?.persistent), requiresElevation, synchronizing: busy, error: lastError,
      publication: lastPublication,
      pendingReplays: database.prepare('SELECT root,phase,position FROM search_ntfs_replays ORDER BY root').all(),
      volumes: database.prepare('SELECT root,complete,last_synced FROM search_ntfs_volumes ORDER BY root').all().map(row => ({ root: row.root, complete: Boolean(row.complete), lastSynced: row.last_synced }))
    }
  }
  async function prepare(roots, { elevate = false } = {}) {
    const requested = roots.filter(localRoot)
    if (!requested.length || closing) return false
    if (elevate) { client?.close(); client = null; failedRoots.clear() }
    try {
      client ||= await clientFactory(cacheDirectory, { elevate })
      if (!client) return false
      rootsAvailable.clear()
      for (const root of requested) {
        for await (const event of client.request({ op: 'probe', root })) {
          if (event.available && identity(event.journalId)) rootsAvailable.add(root.toLowerCase())
          requiresElevation ||= Boolean(event.requiresElevation)
        }
      }
      enabled = rootsAvailable.size > 0
      if (enabled) { requiresElevation = false; lastError = '' }
      else { client.close(); client = null }
    } catch (error) {
      lastError = error.message
      if (client?.persistent && error.code === 'NTFS_TRANSPORT_UNAVAILABLE') {
        rootsAvailable.clear()
        for (const root of requested) if (volumeGet.get(root)?.complete) rootsAvailable.add(root.toLowerCase())
        enabled = rootsAvailable.size > 0
        requiresElevation = false
      } else { client?.close(); client = null; enabled = false }
      if (error.code === 'NTFS_ELEVATION_CANCELLED') requiresElevation = true
      if (elevate) throw error
    }
    changed()
    return enabled
  }
  function usable(root) { return enabled && localRoot(root) && rootsAvailable.has(root.toLowerCase()) && !failedRoots.has(root.toLowerCase()) }
  function hasSnapshot(root) { return Boolean(volumeGet.get(root)?.complete) }
  function validatePath(root, target, name) {
    if (typeof target !== 'string' || typeof name !== 'string' || /[\\/\0]/u.test(name) || !name) throw new Error('Invalid NTFS filename')
    const normalized = path.normalize(target)
    if (!normalized.toLowerCase().startsWith(root.toLowerCase()) || path.basename(normalized) !== name || normalized.includes('\0')) throw new Error('Invalid NTFS path')
    return normalized
  }
  function validateRecord(root, record) {
    if (!Array.isArray(record) || record.length !== 7) throw new Error('Invalid NTFS record')
    const [ref, parent, name, attributes, size, modified, target] = record
    if (!identity(ref) || !identity(parent) || !Number.isSafeInteger(attributes) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(modified)) throw new Error('Invalid NTFS metadata')
    const normalized = validatePath(root, target, name)
    return [ref, parent, name, attributes, size, modified, normalized]
  }
  function insert(root, generation, record, touchGeneration = true) {
    const [ref, parent, name, attributes, size, modified, normalized] = validateRecord(root, record)
    if (isDatabaseFile(normalized)) return false
    const isDirectory = Boolean(attributes & 16), isLink = Boolean(attributes & 1024)
    upsertItem({ target: normalized, row: [normalized, name, root, null, Number(isDirectory), Number(isLink), isDirectory ? 0 : size, modified, generation], ntfs: true, touchGeneration })
    linkSave.run(root, ref, parent, name, normalized, attributes)
    return true
  }
  async function snapshot(root, generation, state, signal) {
    if (!usable(root)) return false
    busy = true
    const previousCheckpoint = database.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
    database.exec('PRAGMA wal_autocheckpoint=16384')
    const initialEntries = state.entries, initialDirectories = state.directories
    const stageRemove = database.prepare('DELETE FROM search_ntfs_snapshot_stage WHERE root=? COLLATE NOCASE')
    const stageSave = database.prepare('INSERT OR REPLACE INTO search_ntfs_snapshot_stage VALUES (?,?,?,?,?,?,?,?)')
    let header, end, published = false
    try {
      stageRemove.run(root)
      for await (const event of client.request({ op: 'snapshot', root })) {
        if (signal.cancelled || closing) return true
        if (event.type === 'volume') {
          if (!identity(event.journalId) || !identity(event.rootId) || !identity(event.nextUsn) || !identity(event.serial)) throw new Error('Invalid NTFS volume identity')
          if (header) throw new Error('Duplicate NTFS volume identity')
          header = event
        } else if (event.type === 'records') {
          if (!header) throw new Error('NTFS snapshot has no volume identity')
          const beforeEntries = state.entries, beforeDirectories = state.directories
          database.exec('BEGIN')
          try {
            for (const row of event.rows) {
              if (state.entries >= maximumEntries) { state.truncated = true; break }
              const [ref, parent, name, attributes, size, modified, normalized] = validateRecord(root, row)
              if (!isDatabaseFile(normalized)) {
                stageSave.run(root, normalized, ref, parent, name, attributes, size, modified)
                state.entries++; if (attributes & 16) state.directories++
              }
            }
            database.exec('COMMIT')
          } catch (error) { database.exec('ROLLBACK'); state.entries = beforeEntries; state.directories = beforeDirectories; throw error }
          progress(state)
          if (state.truncated) return true
          await new Promise(resolve => setImmediate(resolve))
        } else if (event.type === 'progress') {
          state.current = root
          state.nativeStage = event.phase
          state.nativeBytes = event.bytesRead
          state.nativeTotalBytes = event.mftBytes
          progress(state)
        } else if (event.type === 'snapshot-end') end = event
      }
      if (signal.cancelled || closing) return true
      if (!header || !end?.complete || end.serial !== header.serial || end.journalId !== header.journalId) throw new Error('NTFS snapshot was incomplete; preserving existing index')
      // Collection touches only shadow records. Files, derived indexes, the FRN
      // graph and its cursor publish together; a crash cannot activate half a graph.
      state.nativeStage = 'publishing'
      progress(state)
      await new Promise(resolve => setImmediate(resolve))
      if (signal.cancelled || closing) return true
      const publicationStarted = performance.now()
      database.exec('BEGIN')
      try {
        database.prepare('DELETE FROM search_ntfs_links WHERE root=? COLLATE NOCASE').run(root)
        for (const row of database.prepare('SELECT * FROM search_ntfs_snapshot_stage WHERE root=? COLLATE NOCASE').iterate(root)) {
          insert(root, generation, [row.ref, row.parent, row.name, row.attributes, row.size, row.modified, row.path])
        }
        finalizeRoot(root, generation)
        saveVolume(root, header, true)
        replayDiscard(root)
        stageRemove.run(root)
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
      lastPublication = { root, entries: state.entries - initialEntries, tookMs: performance.now() - publicationStarted }
      published = true
      lastError = ''
      return true
    } catch (error) {
      failedRoots.add(root.toLowerCase())
      lastError = error.message
      changed(true)
      if (error.code === 'NTFS_PERMISSION_REQUIRED') requiresElevation = true
      return false
    } finally {
      stageRemove.run(root)
      if (!published) {
        state.entries = initialEntries; state.directories = initialDirectories
      }
      database.exec(`PRAGMA wal_autocheckpoint=${previousCheckpoint}`); busy = false; changed()
    }
  }
  function removeLinkTree(root, target) {
    removeTarget(target)
    // Separate range seeks. Combining these predicates with OR makes SQLite scan
    // every link on the volume for each removed file in a large backlog.
    linksRemove.run(root, target)
    linksRemoveDescendants.run(root, `${like(target + '\\')}%`)
  }
  function moveTree(root, from, to) {
    if (from === to) return
    // Index-only operations; no user files or directories are moved.
    if (from.toLowerCase() !== to.toLowerCase()) removeLinkTree(root, to)
    for (const table of ['search_files', 'search_phonetics', 'search_ntfs_links']) {
      if (table === 'search_ntfs_links') {
        for (const predicate of ["path=? COLLATE NOCASE", "path LIKE ? ESCAPE '\\'"]) {
          const sql = `UPDATE search_ntfs_links SET path=?||substr(path,length(?)+1) WHERE root=? COLLATE NOCASE AND ${predicate}`
          let statement = statements.get(sql)
          if (!statement) { statement = database.prepare(sql); statements.set(sql, statement) }
          statement.run(to, from, root, predicate.startsWith('path LIKE') ? `${like(from + '\\')}%` : from)
        }
        continue
      }
      const sql = `UPDATE ${table} SET path=?||substr(path,length(?)+1) WHERE path=? COLLATE NOCASE OR path LIKE ? ESCAPE '\\'`
      let statement = statements.get(sql)
      if (!statement) { statement = database.prepare(sql); statements.set(sql, statement) }
      statement.run(to, from, from, `${like(from + '\\')}%`)
    }
  }
  async function replay(root, generation) {
    if (!usable(root)) return { used: false }
    const volume = volumeGet.get(root)
    if (!volume?.complete) return { used: false, reset: true }
    busy = true
    const changes = new Map()
    let end, reset, plan = replayGet.get(root), recoveredPlanValidated = !plan
    try {
      if (plan) {
        // Resume the same immutable delta after an interrupted batch. Re-reading
        // live metadata from the old cursor could apply a directory swap twice.
        if (plan.serial !== volume.serial || plan.journal_id !== volume.journal_id || plan.from_usn !== volume.next_usn
          || !identity(plan.to_usn) || BigInt(plan.to_usn) < BigInt(volume.next_usn)
          || !['directories', 'deletions', 'files'].includes(plan.phase) || !Number.isSafeInteger(plan.position) || plan.position < 0) {
          throw new Error('Invalid persisted NTFS replay checkpoint')
        }
        for (const row of database.prepare('SELECT payload FROM search_ntfs_replay_changes WHERE root=? COLLATE NOCASE ORDER BY position').iterate(root)) {
          const change = JSON.parse(row.payload)
          if (!identity(change.id)) throw new Error('Invalid persisted NTFS change')
          changes.set(change.id, change)
        }
        generation = plan.generation
        end = { serial: plan.serial, journalId: plan.journal_id, nextUsn: plan.to_usn }
      } else {
        for await (const event of client.request({ op: 'journal', root, serial: volume.serial, journalId: volume.journal_id, nextUsn: volume.next_usn })) {
          if (closing) return { used: false }
          if (event.type === 'changes') for (const change of event.rows) {
            if (!identity(change.id)) throw new Error('Invalid NTFS file identity')
            changes.set(change.id, change)
          }
          else if (event.type === 'journal-end') end = event
          else if (event.type === 'reset') reset = event
        }
      }
      if (reset) return { used: true, reset: true, reason: reset.reason }
      if (!end || end.serial !== volume.serial || end.journalId !== volume.journal_id || !identity(end.nextUsn) || BigInt(end.nextUsn) < BigInt(volume.next_usn)) throw new Error('Invalid NTFS journal cursor')
      const resolving = new Set(), resolvedPaths = new Map()
      function parentPath(id, depth = 0) {
        if (id === volume.root_id) return root
        if (resolvedPaths.has(id)) return resolvedPaths.get(id)
        if (depth > 512 || resolving.has(id)) throw new Error('NTFS directory cycle')
        const pending = changes.get(id)
        if (pending && !pending.deleted && (pending.attributes & 16) && pending.links.length) {
          resolving.add(id)
          const [parent, name] = pending.links[0]
          const resolved = validatePath(root, path.join(parentPath(parent, depth + 1), name), name)
          resolving.delete(id)
          resolvedPaths.set(id, resolved)
          return resolved
        }
        const known = linksFor.all(root, id).find(link => link.attributes & 16)
        if (!known) throw Object.assign(new Error('NTFS parent directory is missing'), { code: 'NTFS_GRAPH_GAP' })
        resolving.add(id)
        const resolved = validatePath(root, path.join(parentPath(known.parent, depth + 1), known.name), known.name)
        resolving.delete(id)
        resolvedPaths.set(id, resolved)
        return resolved
      }
      const updates = [...changes.values()].filter(change => !change.deleted).sort((a, b) => {
        const directories = Number(Boolean(b.attributes & 16)) - Number(Boolean(a.attributes & 16))
        if (directories) return directories
        return (a.attributes & 16) ? parentPath(a.id).split('\\').length - parentPath(b.id).split('\\').length : 0
      })
      const directories = updates.filter(change => change.attributes & 16).map(change => ({ change,
        desired: change.links.length ? parentPath(change.id) : null
      })).filter(item => item.desired)
      for (const change of updates) for (const [parent, name] of change.links) {
        validateRecord(root, [change.id, parent, name, change.attributes, change.size, change.modified,
          path.join(parentPath(parent), name)])
      }
      recoveredPlanValidated = true
      if (!plan) {
        database.exec('BEGIN')
        try {
          replayDiscard(root)
          const saveChange = database.prepare('INSERT INTO search_ntfs_replay_changes VALUES (?,?,?)')
          let position = 0
          for (const change of changes.values()) saveChange.run(root, position++, JSON.stringify(change))
          database.prepare('INSERT INTO search_ntfs_replays VALUES (?,?,?,?,?,?,?,?)')
            .run(root, volume.serial, volume.journal_id, volume.next_usn, end.nextUsn, generation, 'directories', 0)
          database.exec('COMMIT')
        } catch (error) { database.exec('ROLLBACK'); throw error }
        plan = replayGet.get(root)
      }
      // Stage every moved directory before deleting obsolete parents or occupying
      // destinations. This preserves descendants during swaps and moves out of a
      // deleted tree. Temporary names exist only inside this SQLite transaction.
      if (plan.phase === 'directories') {
      database.exec('BEGIN')
      try {
        for (const { change, desired } of directories) {
          const old = linksFor.all(root, change.id)[0]
          if (old && old.path !== desired) moveTree(root, old.path, path.join(root, `.disk-sense-index-${randomUUID()}`))
        }
        for (const { change, desired } of directories) {
          const old = linksFor.all(root, change.id)[0]
          if (old) moveTree(root, old.path, desired)
        }
        // Register new directory identities before deleting old owners of reused
        // paths. All staged names are resolved before queries can run again.
        for (const { change } of directories) for (const [parent, name] of change.links) {
          insert(root, generation, [change.id, parent, name, change.attributes, change.size, change.modified,
            validatePath(root, path.join(parentPath(parent), name), name)], false)
        }
        replayProgress.run('deletions', 0, root)
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
      plan = replayGet.get(root)
      }
      const deleted = [...changes.values()].filter(change => change.deleted)
      for (let offset = plan.phase === 'deletions' ? plan.position : deleted.length; offset < deleted.length; offset += 256) {
        if (closing) return { used: true, retry: true }
        database.exec('BEGIN')
        try {
          for (const change of deleted.slice(offset, offset + 256)) for (const old of linksFor.all(root, change.id)) removeLinkTree(root, old.path)
          replayProgress.run('deletions', Math.min(offset + 256, deleted.length), root)
          database.exec('COMMIT')
        } catch (error) { database.exec('ROLLBACK'); throw error }
        await new Promise(resolve => setImmediate(resolve))
      }
      // File deletions precede file creations; repeated paths retain their new owner.
      const files = updates.filter(change => !(change.attributes & 16))
      if (plan.phase !== 'files') { replayProgress.run('files', 0, root); plan = replayGet.get(root) }
      for (let offset = plan.position; offset < files.length; offset += 256) {
        if (closing) return { used: true, retry: true }
        database.exec('BEGIN')
        try {
          for (const change of files.slice(offset, offset + 256)) {
            const desired = change.links.map(([parent, name]) => ({ parent, name, path: validatePath(root, path.join(parentPath(parent), name), name) }))
            const wanted = new Set(desired.map(link => link.path.toLowerCase()))
            if (!change.incompleteNames) for (const prior of linksFor.all(root, change.id)) if (!wanted.has(prior.path.toLowerCase())) {
              removeTarget(prior.path); linksRemove.run(root, prior.path)
            }
            for (const link of desired) insert(root, generation, [change.id, link.parent, link.name, change.attributes, change.size, change.modified, link.path], false)
          }
          replayProgress.run('files', Math.min(offset + 256, files.length), root)
          database.exec('COMMIT')
        } catch (error) { database.exec('ROLLBACK'); throw error }
        await new Promise(resolve => setImmediate(resolve))
      }
      database.exec('BEGIN')
      try {
        saveVolume(root, { ...volume, nextUsn: end.nextUsn }, true)
        replayDiscard(root)
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
      lastError = ''
      if (changes.size) changed(true)
      return { used: true, changed: changes.size }
    } catch (error) {
      lastError = error.message
      changed(true)
      // A durable plan owns any already-committed batches. Retry it rather than
      // letting a fresh live delta reinterpret the partially updated graph.
      if (replayGet.get(root) && recoveredPlanValidated) return { used: true, retry: true, reason: error.code || 'journal-apply-interrupted' }
      if (error.code === 'NTFS_TRANSPORT_UNAVAILABLE' || ['EPIPE', 'ECONNRESET', 'ENOENT'].includes(error.code)) return { used: true, retry: true }
      return { used: true, reset: true, reason: error.code || 'journal-apply-failed' }
    } finally { busy = false; changed() }
  }
  function close() { closing = true; client?.close(); client = null; enabled = false }
  async function uninstall() {
    await removePersistentNtfsService(cacheDirectory)
    client?.close(); client = null; enabled = false; rootsAvailable.clear(); requiresElevation = true; changed()
  }
  return { prepare, usable, hasSnapshot, snapshot, replay, status, close, uninstall }
}

module.exports = { createNtfsIndex, localRoot }
