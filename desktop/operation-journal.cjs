'use strict'
const fs = require('node:fs')
const path = require('node:path')

// The external Shell action and SQLite cannot share a transaction. An attempted
// action with no durable confirmation is deliberately never retried here.
function createOperationJournal(file) {
  const { DatabaseSync } = require('node:sqlite')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS operation_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operation_items(job_id TEXT NOT NULL REFERENCES operation_jobs(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
    CREATE INDEX IF NOT EXISTS operation_job_order ON operation_jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS operation_item_state ON operation_items(job_id,state);`)
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE')
    try { const value = action(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const itemInsert = db.prepare('INSERT INTO operation_items VALUES(?,?,?,?)')
  const itemUpdate = db.prepare('UPDATE operation_items SET state=?,payload=? WHERE job_id=? AND ordinal=?')
  const jobGet = db.prepare('SELECT * FROM operation_jobs WHERE id=?')
  const counts = db.prepare(`SELECT COUNT(*) AS requested,
    COALESCE(SUM(state='confirmed'),0) AS succeeded,COALESCE(SUM(state='failed'),0) AS failed,
    COALESCE(SUM(state IN ('attempted','uncertain')),0) AS uncertainCount,
    COALESCE(SUM(CASE WHEN state='confirmed' THEN json_extract(payload,'$.size') ELSE 0 END),0) AS movedToTrashBytes
    FROM operation_items WHERE job_id=?`)
  function summary(row) {
    if (!row) return null
    const total = counts.get(row.id)
    return { ...JSON.parse(row.metadata), ...total, id: row.id, kind: row.kind, state: row.state,
      createdAt: row.created_at, processed: total.succeeded + total.failed + total.uncertainCount,
      cancelled: row.state === 'cancelled' || row.state === 'interrupted',
      recoveryRequired: row.state !== 'reviewed' && (row.state === 'interrupted' || total.uncertainCount > 0),
      executionMode: 'trash', reclaimedBytes: 0 }
  }
  function begin(id, candidates, metadata = {}) {
    if (!Array.isArray(candidates) || candidates.length > 50000) throw new Error('无效的操作计划')
    transaction(() => {
      db.prepare('INSERT INTO operation_jobs VALUES(?,?,?,?,?)').run(id, metadata.kind || 'cleanup', 'running', new Date().toISOString(), JSON.stringify(metadata))
      for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
        const item = candidates[ordinal]
        itemInsert.run(id, ordinal, 'planned', JSON.stringify({ candidateId: String(item?.candidateId || ''),
          path: String(item?.canonicalPath || item?.path || ''), ruleId: String(item?.ruleId || ''),
          size: Number(item?.size || 0), modifiedAt: Number(item?.modifiedAt || 0) }))
      }
    })
  }
  function attempted(id, ordinal, candidate) {
    const result = itemUpdate.run('attempted', JSON.stringify({ candidateId: candidate.candidateId, path: candidate.canonicalPath || candidate.path,
      size: candidate.size, modifiedAt: candidate.modifiedAt, ruleId: candidate.ruleId }), id, ordinal)
    if (result.changes !== 1) throw new Error('无法持久化文件操作，已停止清理')
  }
  function recorded(id, ordinal, result) {
    const changed = itemUpdate.run(result.success ? 'confirmed' : 'failed', JSON.stringify(result), id, ordinal)
    if (changed.changes !== 1) throw new Error('无法持久化操作结果，已停止后续清理')
  }
  function finish(id, result) {
    const { results, ...saved } = result
    const metadata = { ...JSON.parse(jobGet.get(id)?.metadata || '{}'), ...saved }
    db.prepare('UPDATE operation_jobs SET state=?,metadata=? WHERE id=?').run(result.outcome === 'interrupted' ? 'interrupted' : result.cancelled ? 'cancelled' : 'completed',
      JSON.stringify(metadata), id)
    prune()
  }
  function interrupted(id) {
    transaction(() => {
      db.prepare("UPDATE operation_items SET state='uncertain' WHERE job_id=? AND state='attempted'").run(id)
      db.prepare("UPDATE operation_jobs SET state='interrupted' WHERE id=? AND state='running'").run(id)
    })
  }
  function recover() {
    transaction(() => {
      db.exec("UPDATE operation_items SET state='uncertain' WHERE state='attempted'; UPDATE operation_jobs SET state='interrupted' WHERE state='running';")
    })
    return list().filter(job => job.recoveryRequired)
  }
  function list() {
    return db.prepare(`SELECT * FROM operation_jobs WHERE state IN ('running','interrupted')
      OR id IN (SELECT id FROM operation_jobs ORDER BY created_at DESC LIMIT 50)
      ORDER BY created_at DESC`).all().map(summary)
  }
  function detail(id, { offset = 0, limit = 200 } = {}) {
    const job = summary(jobGet.get(id))
    if (!job) return null
    offset = Math.max(0, Math.floor(Number(offset) || 0))
    limit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 200)))
    const results = db.prepare('SELECT ordinal,state,payload FROM operation_items WHERE job_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(id, limit, offset)
      .map(row => ({ ...JSON.parse(row.payload), ordinal: row.ordinal, operationState: row.state, success: row.state === 'confirmed',
        ...(row.state === 'uncertain' || row.state === 'attempted' ? { error: '操作结果未确认，请到回收站核对；需要处理时重新扫描。' }
          : row.state === 'planned' ? { error: '该文件尚未执行' } : {}) }))
    return { ...job, results, offset, nextOffset: offset + results.length < job.requested ? offset + results.length : null, omittedResults: 0 }
  }
  function prune() {
    // Recovery evidence is never removed by ordinary history retention.
    db.exec("DELETE FROM operation_jobs WHERE state IN ('completed','cancelled','reviewed') AND id NOT IN (SELECT id FROM operation_jobs ORDER BY created_at DESC LIMIT 50)")
    while (db.prepare('SELECT COUNT(*) AS count FROM operation_items').get().count > 100000) {
      const oldest = db.prepare("SELECT id FROM operation_jobs WHERE state IN ('completed','cancelled','reviewed') ORDER BY created_at LIMIT 1").get()
      if (!oldest) break
      db.prepare('DELETE FROM operation_jobs WHERE id=?').run(oldest.id)
    }
  }
  function clearCompleted() {
    db.exec("DELETE FROM operation_jobs WHERE state IN ('completed','cancelled','reviewed')")
    return { retained: list().filter(job => job.recoveryRequired).length }
  }
  function acknowledge(id) {
    return { acknowledged: db.prepare("UPDATE operation_jobs SET state='reviewed' WHERE id=? AND state='interrupted'").run(String(id)).changes === 1 }
  }
  return { begin, attempted, recorded, finish, interrupted, recover, list, detail, clearCompleted, acknowledge,
    checkpoint: () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), close: () => db.close() }
}
module.exports = { createOperationJournal }
