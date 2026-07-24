const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', 'desktop')
function modules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return modules(target)
    return entry.isFile() && entry.name.endsWith('.cjs') ? [target] : []
  })
}
const files = modules(root)

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`)
  }
}

if (failed) process.exit(1)
process.stdout.write(`Checked ${files.length} desktop modules.\n`)
