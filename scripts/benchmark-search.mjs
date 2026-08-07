import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createFileSearchWorkerService } = require('../desktop/file-search-client.cjs')
const requested = Number.parseInt(process.env.DISK_SENSE_BENCH_FILES || '5000', 10)
const fileCount = Math.max(100, Math.min(100_000, Number.isFinite(requested) ? requested : 5000))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sense-search-benchmark-'))
const contentRoot = path.join(root, 'Documents')
let service

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] || 0
}

try {
  fs.mkdirSync(contentRoot, { recursive: true })
  for (let index = 0; index < fileCount; index++) {
    const group = path.join(contentRoot, `group-${String(Math.floor(index / 250)).padStart(3, '0')}`)
    fs.mkdirSync(group, { recursive: true })
    const extension = index % 7 === 0 ? '.docx' : index % 5 === 0 ? '.pdf' : '.txt'
    fs.writeFileSync(path.join(group, `project-${String(index).padStart(6, '0')}${extension}`), 'fixture')
  }

  service = createFileSearchWorkerService({
    databasePath: path.join(root, '.state', 'search.sqlite'),
    getVolumeRoots: async () => [root]
  })

  let maximumEventLoopDelay = 0
  let expectedTick = performance.now() + 10
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maximumEventLoopDelay = Math.max(maximumEventLoopDelay, now - expectedTick)
    expectedTick = now + 10
  }, 10)
  const indexStarted = performance.now()
  await service.rebuild({ roots: [root] })
  const indexStatus = await service.waitForIdle()
  const indexDuration = performance.now() - indexStarted
  clearInterval(heartbeat)

  const samples = []
  for (const query of ['project', 'project-000777', '*.docx', 'project-004']) {
    for (let iteration = 0; iteration < 8; iteration++) {
      const started = performance.now()
      await service.search({ query, scope: 'all', kind: 'all', modified: 'any', sort: 'relevance', limit: 300 })
      samples.push(performance.now() - started)
    }
  }

  process.stdout.write(`${JSON.stringify({
    fixtureFiles: fileCount,
    indexedEntries: indexStatus.entries,
    indexDurationMs: Math.round(indexDuration),
    entriesPerSecond: Math.round(indexStatus.entries / Math.max(indexDuration / 1000, 0.001)),
    mainEventLoopMaximumDelayMs: Number(maximumEventLoopDelay.toFixed(1)),
    searchMedianMs: Number(percentile(samples, 0.5).toFixed(1)),
    searchP95Ms: Number(percentile(samples, 0.95).toFixed(1)),
    searchMaximumMs: Number(Math.max(...samples).toFixed(1))
  }, null, 2)}\n`)
} finally {
  await service?.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
}
