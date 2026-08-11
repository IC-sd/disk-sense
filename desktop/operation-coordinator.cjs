const MODES = new Set(['cleanup-scan', 'cleanup-execute', 'maintenance', 'change-scan', 'data-migration'])

function operationLabel(kind) {
  return {
    'cleanup-scan': '垃圾扫描',
    'cleanup-execute': '垃圾清理',
    maintenance: '系统维护',
    'change-scan': '空间变化扫描',
    'data-migration': '数据目录迁移'
  }[kind] || '磁盘任务'
}

function createOperationCoordinator() {
  const cleanupScans = new Map()
  let exclusive = null

  function snapshot() {
    return {
      exclusive: exclusive ? { kind: exclusive.kind, id: exclusive.id } : null,
      cleanupScans: [...cleanupScans.values()].map(item => ({ kind: item.kind, id: item.id }))
    }
  }

  function acquire(kind, id) {
    if (!MODES.has(kind)) throw new Error(`未知磁盘任务：${kind}`)
    const operation = { kind, id: String(id || `${kind}-${Date.now()}`) }
    if (kind === 'cleanup-scan') {
      if (exclusive) {
        throw new Error(`${operationLabel(exclusive.kind)}正在进行，请等待完成或先取消该任务`)
      }
      const token = Symbol(operation.id)
      cleanupScans.set(token, operation)
      let released = false
      return () => {
        if (released) return
        released = true
        cleanupScans.delete(token)
      }
    }

    if (exclusive) {
      throw new Error(`${operationLabel(exclusive.kind)}正在进行，请等待完成或先取消该任务`)
    }
    if (cleanupScans.size) {
      throw new Error('垃圾扫描正在进行，请等待扫描完成或先取消扫描')
    }
    exclusive = operation
    let released = false
    return () => {
      if (released) return
      released = true
      if (exclusive === operation) exclusive = null
    }
  }

  return { acquire, snapshot }
}

module.exports = { createOperationCoordinator, operationLabel }
