// Read-only measurements against an existing index. Session tables live in memory.
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createSearchEngine } = require('../desktop/search-engine.cjs')

const databasePath = process.argv.slice(2).find(value => !value.startsWith('--')) || path.join(process.env.APPDATA, 'Disk Sense', 'disk-sense-search.sqlite')
if (!fs.existsSync(databasePath)) throw new Error('Search index does not exist')
const database = new DatabaseSync(databasePath, { readOnly: true })
if (!process.argv.includes('--json')) process.stdout.write('Opened existing index read-only.\n')
database.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536; PRAGMA busy_timeout=2000;')
try {
  const engine = createSearchEngine(database, { cacheMs: 0, profile: (stage, ms) => { if (process.argv.includes('--profile')) process.stdout.write(`${stage}: ${ms.toFixed(1)} ms\n`) } })
  const entries = Number(database.prepare('SELECT count(*) AS count FROM search_files').get().count)
  if (!process.argv.includes('--json')) process.stdout.write(`Indexed entries: ${entries}\n`)
  const measurements = []
  for (const query of ['word', 'listary', 'vsc', 'report', 'baogao', 'Documents report']) {
    const times = []
    let result
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      result = engine.search({ query, scope: 'all', kind: 'all', sort: 'relevance', limit: 100 })
      times.push(performance.now() - start)
    }
    measurements.push({ query, total: result.total, returned: result.rows.length, medianMs: +times.sort((a, b) => a - b)[1].toFixed(1), maximumMs: +Math.max(...times).toFixed(1) })
    if (!process.argv.includes('--json')) process.stdout.write(JSON.stringify(measurements.at(-1)) + '\n')
  }
  process.stdout.write(JSON.stringify({ entries, measurements }, null, 2) + '\n')
} finally { database.close() }
