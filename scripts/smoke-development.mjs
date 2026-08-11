import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { createServer } from 'vite'

const host = '127.0.0.1'
const requestedPort = Number.parseInt(process.env.DISK_SENSE_SMOKE_DEV_PORT || '5189', 10)
const server = await createServer({
  configLoader: 'runner',
  server: {
    host,
    port: requestedPort,
    strictPort: true
  }
})

try {
  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort
  const servedHtml = await (await fetch(`http://${host}:${port}/`)).text()
  if (!servedHtml.includes(`connect-src 'self' ws://${host}:${port};`)) {
    throw new Error('development CSP does not contain the selected HMR WebSocket origin')
  }
  const child = spawn(process.execPath, [
    path.resolve('scripts/smoke-desktop.mjs'),
    path.resolve('node_modules/electron/dist/electron.exe')
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      DISK_SENSE_DEV_SERVER_URL: `http://${host}:${port}/`,
      DISK_SENSE_SMOKE_DEV: '1'
    }
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(`development desktop smoke failed with exit code ${exitCode}`)
} finally {
  await server.close()
}
