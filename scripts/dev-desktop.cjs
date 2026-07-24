const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const desktopRoot = path.join(projectRoot, 'desktop')
const pidFile = path.join(projectRoot, '.dev-desktop.pid.json')

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function claimSingleLauncher() {
  try {
    const previous = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    if (processExists(Number(previous.launcherPid))) {
      throw new Error(`Disk Sense 桌面开发模式已经在运行（PID ${previous.launcherPid}）`)
    }
  } catch (error) {
    if (error?.message?.includes('已经在运行')) throw error
  }
  fs.writeFileSync(pidFile, JSON.stringify({
    launcherPid: process.pid,
    electronPid: null,
    startedAt: new Date().toISOString()
  }, null, 2))
}

function updatePidFile(electronPid) {
  try {
    fs.writeFileSync(pidFile, JSON.stringify({
      launcherPid: process.pid,
      electronPid,
      startedAt: new Date().toISOString()
    }, null, 2))
  } catch {
    // Development continues even if the diagnostic PID file cannot be updated.
  }
}

function desktopModuleStamps() {
  const stamps = new Map()
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.endsWith('.cjs')) {
        const stat = fs.statSync(target)
        stamps.set(path.relative(desktopRoot, target).toLowerCase(), `${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  visit(desktopRoot)
  return stamps
}

async function main() {
  claimSingleLauncher()
  const { createServer } = await import('vite')
  const server = await createServer()
  await server.listen()
  server.printUrls()

  const electronExecutable = require('electron')
  let electron = null
  let watcher = null
  let restartTimer = null
  let restarting = false
  let closing = false
  const moduleStamps = desktopModuleStamps()

  const launchElectron = () => {
    if (closing) return
    electron = spawn(electronExecutable, [
      path.join(desktopRoot, 'main.cjs'),
      '--dev'
    ], {
      cwd: projectRoot,
      stdio: 'inherit',
      // Electron is a GUI executable. Hiding the child process can also hide
      // BrowserWindow after a main-process hot restart on Windows.
      windowsHide: false
    })
    updatePidFile(electron.pid)
    electron.once('exit', code => {
      updatePidFile(null)
      electron = null
      if (closing) return
      if (restarting) {
        restarting = false
        launchElectron()
        return
      }
      void close(code || 0)
    })
    electron.once('error', error => {
      console.error(error)
      if (!restarting) void close(1)
    })
  }

  const restartElectron = () => {
    if (closing) return
    if (!electron || electron.exitCode !== null) {
      restarting = false
      launchElectron()
      return
    }
    restarting = true
    electron.kill()
  }

  const scheduleRestart = (eventType, filename) => {
    if (!filename || !String(filename).endsWith('.cjs')) return
    const relative = String(filename).replaceAll('/', path.sep)
    const modulePath = path.resolve(desktopRoot, relative)
    if (modulePath !== desktopRoot && !modulePath.startsWith(`${desktopRoot}${path.sep}`)) return
    const stampKey = path.relative(desktopRoot, modulePath).toLowerCase()
    let nextStamp = null
    try {
      const stat = fs.statSync(modulePath)
      if (!stat.isFile()) return
      nextStamp = `${stat.size}:${stat.mtimeMs}`
    } catch {
      // Atomic editor writes may briefly remove a file before replacing it.
    }
    if (moduleStamps.get(stampKey) === nextStamp) return
    if (nextStamp === null) moduleStamps.delete(stampKey)
    else moduleStamps.set(stampKey, nextStamp)
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      process.stdout.write(`[desktop] ${eventType}: ${filename}，正在重启唯一桌面窗口\n`)
      restartElectron()
    }, 350)
  }

  const close = async exitCode => {
    if (closing) return
    closing = true
    clearTimeout(restartTimer)
    watcher?.close()
    if (electron && electron.exitCode === null) electron.kill()
    await server.close()
    try {
      const current = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
      if (Number(current.launcherPid) === process.pid) fs.rmSync(pidFile, { force: true })
    } catch {
      // Stale diagnostic files are ignored on the next launch.
    }
    process.exitCode = exitCode
  }

  watcher = fs.watch(desktopRoot, { recursive: true }, scheduleRestart)
  launchElectron()
  process.once('SIGINT', () => void close(0))
  process.once('SIGTERM', () => void close(0))
}

main().catch(error => {
  console.error(error)
  try { fs.rmSync(pidFile, { force: true }) } catch {}
  process.exitCode = 1
})
