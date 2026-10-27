// Synthetic NTFS transport only: no volume handles, service installation or
// user-file enumeration. Exercise the production SQLite/phonetic/word hooks.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFileSearchService } = require('../desktop/file-search.cjs')

const requested = Number(process.env.DISK_SENSE_PUBLICATION_FILES || 10000)
const count = Math.min(100000, Math.max(100, Number.isSafeInteger(requested) ? requested : 10000))
const root = [...'ZYXWVUTSRQPONMLKJIHGFED'].map(letter => `${letter}:\\`).find(volume => !fs.existsSync(volume))
if (!root) throw new Error('No unused drive letter available for a synthetic volume fixture')
const temporaryParent = path.resolve(os.tmpdir())
const directory = fs.mkdtempSync(path.join(temporaryParent, 'disk-sense-publication-bench-'))
let service, variant = 0
const clientFactory = async () => ({ persistent: false, close() {}, async *request(input) {
  if (input.op === 'probe') { yield { available: true, journalId: '10' }; return }
  if (input.op === 'journal') { yield { type: 'journal-end', serial: '42', journalId: '10', nextUsn: '100' }; return }
  if (input.op !== 'snapshot') throw new Error('Unexpected synthetic request')
  yield { type: 'volume', serial: '42', journalId: '10', rootId: '5', nextUsn: '100' }
  for (let start = 0; start < count; start += 500) {
    const rows = []
    for (let index = start; index < Math.min(start + 500, count); index++) {
      const stem = index % 4 ? 'project' : '季度报告'
      const renamed = variant === 2 && index % 10 === 0 ? '-renamed' : ''
      const name = `${stem}-${String(index).padStart(6, '0')}${renamed}.txt`
      rows.push([String(10000 + index), '5', name, 32, index + (variant === 2 ? 1 : 0), 1000 + index, root + name])
    }
    yield { type: 'records', rows }
  }
  yield { type: 'snapshot-end', serial: '42', journalId: '10', complete: true }
} })

;(async () => {
  try {
    service = createFileSearchService({ databasePath: path.join(directory, 'index.sqlite'),
      maximumEntries: count + 1, getVolumeRoots: async () => [root], ntfsClientFactory: clientFactory, reconcileIntervalMs: 0 })
    const results = []
    for (const mode of ['first', 'unchanged', 'changed']) {
      const started = performance.now()
      if (!variant) await service.startAutomatic()
      else await service.rebuild({ roots: [root] })
      await service.waitForIdle()
      const status = service.status()
      if (status.entries !== count || status.ntfs?.publication?.entries !== count) throw new Error('Synthetic snapshot did not publish the complete fixture')
      results.push({ mode, fullMs: performance.now() - started, publication: status.ntfs.publication })
      variant++
    }
    const result = service.search({ query: 'project', limit: 100, sort: 'relevance' })
    process.stdout.write(JSON.stringify({ synthetic: true, files: count, results,
      query: { total: result.total, returned: result.items.length, diagnostics: result.diagnostics },
      limits: 'Synthetic local SQLite timing; no real MFT, USN or GUI latency measurement. Publication is synchronous on the search worker.' }, null, 2) + '\n')
  } finally {
    await service?.close()
    const target = path.resolve(directory)
    if (path.dirname(target) !== temporaryParent || !path.basename(target).startsWith('disk-sense-publication-bench-')) throw new Error('Invalid owned fixture directory')
    fs.rmSync(target, { recursive: true, force: true })
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
