const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const packageJson = require('../package.json')

const releaseDirectory = path.resolve(__dirname, '..', 'release')
const names = [
  `Disk Sense-Setup-${packageJson.version}-x64.exe`,
  `Disk Sense-Portable-${packageJson.version}-x64.exe`
]

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .once('end', resolve)
      .once('error', reject)
  })
  return hash.digest('hex')
}

async function main() {
  const lines = []
  for (const name of names) {
    const file = path.join(releaseDirectory, name)
    if (!fs.existsSync(file)) throw new Error(`Missing release artifact: ${name}`)
    lines.push(`${await sha256(file)}  ${name}`)
  }
  const contents = `${lines.join('\n')}\n`
  const outputs = [
    path.join(releaseDirectory, `SHA256SUMS-${packageJson.version}.txt`),
    path.join(releaseDirectory, 'SHA256SUMS.txt')
  ]
  for (const output of outputs) fs.writeFileSync(output, contents, 'utf8')
  process.stdout.write(`${lines.join('\n')}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
