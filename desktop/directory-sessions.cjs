'use strict'
const fsp = require('node:fs/promises')
const { randomUUID } = require('node:crypto')

function createDirectorySessions({ validate, present, openDirectory = root => fsp.opendir(root, { bufferSize: 256 }), pageSize = 5000, idleMs = 60000, maximumSessions = 4, now = Date.now }) {
  const sessions = new Map()
  const generations = new Map()
  function touch(session) {
    session.usedAt = now()
    clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      if (session.busy) touch(session)
      else void close(session.id)
    }, idleMs)
    session.timer.unref?.()
  }
  async function close(id, owner) {
    const session = sessions.get(id)
    if (!session || (owner !== undefined && session.owner !== owner)) return
    session.closed = true
    clearTimeout(session.timer)
    sessions.delete(id)
    try { await session.handle.close() } catch {}
  }
  async function sweep(owner) {
    for (const [id, session] of sessions) if (now() - session.usedAt > idleMs) await close(id)
    const owned = [...sessions.values()].filter(session => session.owner === owner)
    while (owned.length >= maximumSessions) await close(owned.shift().id)
  }
  async function page(input, owner = 0) {
    const session = sessions.get(input?.sessionId)
    if (!session || session.owner !== owner || now() - session.usedAt > idleMs) {
      if (session?.owner === owner) await close(session.id)
      throw new Error('目录会话已失效，请刷新该目录')
    }
    if (session.busy || (input.offset !== undefined && input.offset !== session.offset)) throw new Error('目录批次已变化，请刷新该目录')
    session.busy = true
    touch(session)
    try {
      const entries = []
      if (session.pending) { entries.push(session.pending); session.pending = null }
      while (entries.length <= pageSize && !session.closed) {
        const entry = await session.handle.read()
        if (!entry) break
        entries.push(entry)
      }
      if (session.closed) throw new Error('目录读取已取消')
      const hasMore = entries.length > pageSize
      if (hasMore) session.pending = entries.pop()
      const offset = session.offset
      session.offset += entries.length
      const result = await present(session.root, entries, hasMore)
      if (session.closed) throw new Error('目录读取已取消')
      const response = { ...result, sessionId: session.id, offset, nextOffset: hasMore ? session.offset : null, complete: !hasMore }
      if (!hasMore) await close(session.id)
      return response
    } catch (error) { await close(session.id); throw error }
    finally { session.busy = false; if (!session.closed) touch(session) }
  }
  async function start(directory, owner = 0) {
    const root = validate(directory)
    const generation = (generations.get(owner) || 0) + 1
    generations.set(owner, generation)
    await sweep(owner)
    const handle = await openDirectory(root)
    if (generations.get(owner) !== generation) {
      try { await handle.close() } catch {}
      throw new Error('目录读取已取消')
    }
    await sweep(owner)
    const id = randomUUID()
    sessions.set(id, { id, root, handle, owner, usedAt: now(), offset: 0, busy: false, closed: false, pending: null })
    return page({ sessionId: id }, owner)
  }
  async function closeOwner(owner) {
    generations.set(owner, (generations.get(owner) || 0) + 1)
    for (const [id, session] of sessions) if (session.owner === owner) await close(id)
  }
  return { start, page, close, closeOwner }
}
module.exports = { createDirectorySessions }
