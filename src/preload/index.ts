import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BpsApi } from '../shared/ipc'
import type { SerializedAppError } from '../shared/errors'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: SerializedAppError
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result?.ok) {
    const error = new Error(result?.error?.message ?? 'La operación falló.') as Error & {
      code?: string
      details?: Record<string, unknown>
    }
    error.code = result?.error?.code
    error.details = result?.error?.details
    throw error
  }
  return result.data as T
}

const api: BpsApi = {
  getBootstrap: () => call(IPC.bootstrap),
  refreshCatalog: () => call(IPC.refreshCatalog),
  rescanPackages: () => call(IPC.rescanPackages),
  importPackageFile: () => call(IPC.importPackageFile),
  addPackageFolder: () => call(IPC.addPackageFolder),
  chooseInstallationRoot: () => call(IPC.chooseInstallationRoot),
  updateSettings: (patch) => call(IPC.updateSettings, patch),
  chooseInstallFolder: (gameId) => call(IPC.chooseInstallFolder, gameId),
  startInstall: (request) => call(IPC.startInstall, request),
  cancelOperation: (gameId) => call(IPC.cancelOperation, gameId),
  revalidateInstall: (gameId) => call(IPC.revalidateInstall, gameId),
  launchGame: (gameId) => call(IPC.launchGame, gameId),
  revealGame: (gameId) => call(IPC.revealGame, gameId),
  refreshMetadata: (gameId) => call(IPC.refreshMetadata, gameId),
  searchIdentity: (gameId, query) => call(IPC.searchIdentity, gameId, query),
  chooseIdentity: (gameId, candidateKey) => call(IPC.chooseIdentity, gameId, candidateKey),
  clearIdentity: (gameId) => call(IPC.clearIdentity, gameId),
  getArtworkGallery: (gameId, kind) => call(IPC.artworkGallery, gameId, kind),
  selectArtwork: (gameId, kind, artworkId) => call(IPC.selectArtwork, gameId, kind, artworkId),
  importLocalArtwork: (gameId, kind) => call(IPC.importLocalArtwork, gameId, kind),
  resetArtwork: (gameId, kind) => call(IPC.resetArtwork, gameId, kind),
  getProviderStatus: () => call(IPC.providerStatus),
  setSteamGridDbKey: (key) => call(IPC.setSteamGridDbKey, key),
  clearSteamGridDbKey: () => call(IPC.clearSteamGridDbKey),
  refreshSteamAccounts: () => call(IPC.refreshAccounts),
  selectSteamAccount: (accountId) => call(IPC.selectSteamAccount, accountId),
  prepareSteamSync: () => call(IPC.prepareSteamSync),
  startSteamSync: (confirmed) => call(IPC.startSteamSync, confirmed),
  getSteamStatus: () => call(IPC.getSteamStatus),
  openLogFolder: () => call(IPC.openLogFolder),
  openPath: (targetPath, purpose) => call(IPC.openPath, targetPath, purpose),
  quit: () => call(IPC.quit),
  onEvent: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { type: string; payload: unknown }
    ): void => {
      listener(payload as never)
    }
    ipcRenderer.on(IPC.event, handler)
    return () => {
      ipcRenderer.removeListener(IPC.event, handler)
    }
  }
}

contextBridge.exposeInMainWorld('bps', api)
