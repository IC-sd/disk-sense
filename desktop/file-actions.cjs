const path = require('node:path')
const fsp = require('node:fs').promises

/** @param {unknown} value */
function fileActionTarget(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new Error('请选择有效的本地文件或目录')
  const target = value.replaceAll('/', '\\')
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/iu.test(target) || /^\\\\[?.]\\/u.test(target) || target.slice(2).includes(':')) {
    throw new Error('仅支持完整的 Windows 文件路径')
  }
  return path.win32.normalize(target)
}

/**
 * @param {{action?: string, path?: string, query?: string}} input
 * @param {{shell: Pick<import('electron').Shell, 'openPath' | 'showItemInFolder'>,
 * clipboard: Pick<import('electron').Clipboard, 'writeText'>, stat?: typeof fsp.lstat,
 * onOpened?: (value: {query?: string, path: string}) => unknown}} dependencies
 */
async function executeFileAction(input, { shell, clipboard, stat = fsp.lstat, onOpened }) {
  if (!['open', 'reveal', 'copy'].includes(input?.action || '')) throw new Error('不支持的文件操作')
  const target = fileActionTarget(input.path)
  try { await stat(target) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new Error('文件已移动或删除，请刷新结果')
    throw error
  }
  if (input.action === 'open') {
    const error = await shell.openPath(target)
    if (error) throw new Error(`无法打开：${error}`)
    if (onOpened) {
      try { await onOpened({ query: input.query, path: target }) } catch { /* History availability must not change a successful open. */ }
    }
  } else if (input.action === 'reveal') shell.showItemInFolder(target)
  else clipboard.writeText(target)
  return { ok: true, path: target, action: input.action }
}

module.exports = { fileActionTarget, executeFileAction }
