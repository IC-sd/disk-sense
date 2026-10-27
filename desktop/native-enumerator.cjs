const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createInterface } = require('node:readline')

// A persistent helper obtains name/size/date in one directory enumeration.
async function createNativeEnumerator(cacheDirectory) {
  if (process.platform !== 'win32') return null
  const source = path.join(__dirname, 'search-enumerator.cs')
  const digest = crypto.createHash('sha256').update(await fs.promises.readFile(source)).digest('hex').slice(0, 20)
  const executable = path.join(cacheDirectory, `enumerator-${digest}.exe`)
  if (!fs.existsSync(executable)) {
    await fs.promises.mkdir(cacheDirectory, { recursive: true })
    const compileSource = path.join(cacheDirectory, `enumerator-${digest}.cs`)
    await fs.promises.copyFile(source, compileSource)
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${executable}`, compileSource], {
      windowsHide: true, timeout: 30_000
    })
  }
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const lines = reader[Symbol.asyncIterator]()
  let failure = null
  const failed = error => { error.code = 'NATIVE_ENUMERATOR_FAILED'; failure = error }
  child.on('error', failed)
  child.stdin.on('error', failed)
  child.on('exit', code => { if (!failure) failed(new Error(`目录枚举进程退出（${code}）`)) })
  child.stderr.resume()
  return {
    async *enumerate(directory) {
      if (failure) throw failure
      child.stdin.write(`${JSON.stringify(directory)}\n`)
      while (true) {
        const next = await lines.next()
        if (next.done) { if (!failure) failed(new Error('目录枚举进程提前结束')); throw failure }
        const batch = JSON.parse(next.value)
        yield batch
        if (batch.done) return
      }
    },
    close() { reader.close(); child.stdin.destroy(); child.kill() }
  }
}

module.exports = { createNativeEnumerator }
