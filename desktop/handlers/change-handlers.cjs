const { inventory, diff, INVENTORY_SCHEMA_VERSION } = require('../change-tracker.cjs')

function publicSnapshot(snapshot) {
  return snapshot ? {
    schemaVersion: snapshot.schemaVersion,
    createdAt: snapshot.createdAt,
    roots: snapshot.roots,
    truncated: Boolean(snapshot.truncated),
    durationMs: snapshot.durationMs,
    entryCount: snapshot.entries?.length || snapshot.entryCount || 0,
    directoryCount: snapshot.scannedDirectories?.length || snapshot.directoryCount || 0,
    rootCoverage: snapshot.rootCoverage || []
  } : null
}

function publicLast(last) {
  return last ? {
    id: last.id,
    createdAt: last.createdAt,
    snapshot: last.snapshot,
    result: last.result
  } : null
}

function historyRecord(id, baseline, snapshot, result, createdAt) {
  return {
    id,
    createdAt,
    baselineCreatedAt: baseline.createdAt,
    roots: snapshot.roots,
    summary: result.summary,
    partial: result.coverage.partial
  }
}

function registerChangeHandlers({ ipcMain, db, sendToRenderer }) {
  let activeScan = null
  const progress = (id, value) => sendToRenderer('changes:progress', { id, ...value })

  ipcMain.handle('changes:state', () => ({
    baseline: publicSnapshot(db.read().changeBaseline),
    last: publicLast(db.read().lastChangeScan),
    history: db.read().changeScans || []
  }))

  ipcMain.handle('changes:baseline', async () => {
    if (activeScan) return { running: true, id: activeScan.id }
    const id = `baseline-${Date.now()}`
    const controller = new AbortController()
    activeScan = { id, controller }
    try {
      const snapshot = await inventory({}, {
        signal: controller.signal,
        onProgress: value => progress(id, value)
      })
      if (!snapshot.cancelled) {
        db.read().changeBaseline = { ...snapshot, createdAt: new Date().toISOString() }
        db.save()
      }
      return {
        id,
        running: false,
        snapshot: publicSnapshot(db.read().changeBaseline),
        baselineCreatedAt: db.read().changeBaseline?.createdAt
      }
    } finally {
      activeScan = null
    }
  })

  ipcMain.handle('changes:scan', async () => {
    const baseline = db.read().changeBaseline
    if (!baseline) return { ok: false, reason: '请先建立一次变化基线' }
    if (baseline.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
      return { ok: false, reason: '变化扫描规则已经升级，请重新建立基线' }
    }
    if (activeScan) return { ok: false, reason: '变化扫描正在进行' }

    const id = `changes-${Date.now()}`
    const controller = new AbortController()
    activeScan = { id, controller }
    try {
      const snapshot = await inventory({}, {
        signal: controller.signal,
        onProgress: value => progress(id, value)
      })
      if (snapshot.cancelled) return { ok: false, reason: '变化扫描已取消' }
      const result = diff(baseline, snapshot)
      const createdAt = new Date().toISOString()
      db.read().lastChangeScan = {
        id,
        createdAt,
        snapshot: publicSnapshot(snapshot),
        result
      }
      db.read().changeScans = [
        historyRecord(id, baseline, snapshot, result, createdAt),
        ...(db.read().changeScans || [])
      ].slice(0, 50)
      db.save()
      return {
        ok: true,
        id,
        ...result,
        baselineCreatedAt: baseline.createdAt,
        scannedAt: createdAt
      }
    } finally {
      activeScan = null
    }
  })

  ipcMain.handle('changes:cancel', () => {
    if (!activeScan) return { cancelled: false }
    activeScan.controller.abort()
    return { cancelled: true, id: activeScan.id }
  })
}

module.exports = {
  registerChangeHandlers,
  publicSnapshot,
  publicLast,
  historyRecord
}
