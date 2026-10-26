import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CreateWindowOptions {
  preloadPath: string
  devUrl?: string
  windowed?: boolean
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), 'resources', 'branding', 'icon.png')
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0e13',
    fullscreen: !options.windowed,
    autoHideMenuBar: true,
    icon: iconPath,
    title: 'BPSteamFit',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  Menu.setApplicationMenu(null)
  window.setMenuBarVisibility(false)

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const localIndexUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const isDev = Boolean(options.devUrl) && targetUrl.startsWith(options.devUrl ?? '')
    const isLocalIndex =
      targetUrl === localIndexUrl || targetUrl.startsWith(`${localIndexUrl}#`)
    if (!isDev && !isLocalIndex) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen())
      event.preventDefault()
    }
    if (options.devUrl && input.key === 'F12') {
      window.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (options.devUrl) {
    void window.loadURL(options.devUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

export function setPermissionPolicy(): void {
  const { session } = require('electron') as typeof import('electron')
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}
