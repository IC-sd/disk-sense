function lockDownSession(electronSession) {
  if (!electronSession?.setPermissionCheckHandler || !electronSession?.setPermissionRequestHandler) {
    throw new Error('Electron session permission controls are unavailable')
  }
  electronSession.setPermissionCheckHandler(() => false)
  electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}

module.exports = { lockDownSession }
