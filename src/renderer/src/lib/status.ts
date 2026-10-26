import type { CatalogGame, InstallState, SteamGameState } from '@shared/domain'
import { INSTALL_STATE_LABELS } from './format'

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted'

export interface StatusInfo {
  label: string
  tone: StatusTone
  detail?: string
}

export interface LibraryFilter {
  id: 'all' | 'installed' | 'steam' | 'issues'
  label: string
}

export const LIBRARY_FILTERS: readonly LibraryFilter[] = [
  { id: 'all', label: 'Todo el salón' },
  { id: 'installed', label: 'Instalados' },
  { id: 'steam', label: 'Steam pendiente' },
  { id: 'issues', label: 'Requieren atención' }
]

export function packageIssue(game: CatalogGame): string | null {
  if (!game.packageAvailable) {
    return game.packageProblem ?? 'El archivo del paquete no está disponible.'
  }
  return game.packageProblem ?? null
}

export function installStatus(game: CatalogGame): StatusInfo {
  const state: InstallState = game.install.state
  if (state === 'failed') {
    return { label: 'Fallo de instalación', tone: 'danger', detail: game.install.error?.message }
  }
  if (state === 'installed') {
    return { label: 'Instalado', tone: 'ok' }
  }
  if (state === 'reboot_pending') {
    return { label: 'Reinicio pendiente', tone: 'warn' }
  }
  if (state === 'interrupted') {
    return { label: 'Interrumpido', tone: 'warn' }
  }
  if (state === 'cancelled') {
    return { label: 'Cancelado', tone: 'muted' }
  }
  if (state === 'validating' || state === 'extracting' || state === 'installing' || state === 'verifying') {
    return { label: INSTALL_STATE_LABELS[state], tone: 'info' }
  }
  if (!game.packageAvailable) {
    return { label: 'Paquete ausente', tone: 'danger', detail: packageIssue(game) ?? undefined }
  }
  return { label: 'Disponible', tone: 'muted' }
}

export function steamStatus(game: CatalogGame): StatusInfo | null {
  if (!game.steam.enabled) return null
  const state: SteamGameState['syncState'] = game.steam.syncState
  if (state === 'pending') return { label: 'Pendiente Steam', tone: 'warn' }
  if (state === 'failed') return { label: 'Steam falló', tone: 'danger' }
  if (state === 'synced') return { label: 'En Steam', tone: 'ok' }
  return null
}

export function needsAttention(game: CatalogGame): boolean {
  return Boolean(
    packageIssue(game) ||
      ['failed', 'interrupted', 'reboot_pending'].includes(game.install.state) ||
      game.steam.syncState === 'failed'
  )
}

export function matchesLibraryFilter(game: CatalogGame, filter: LibraryFilter['id']): boolean {
  if (filter === 'all') return true
  if (filter === 'installed') {
    return game.install.state === 'installed' || game.install.state === 'reboot_pending'
  }
  if (filter === 'steam') return game.steam.syncState === 'pending' || game.steam.syncState === 'failed'
  return needsAttention(game)
}

export function packageSummary(games: readonly CatalogGame[]): StatusInfo {
  if (games.length === 0) return { label: 'Sin paquetes', tone: 'muted' }
  const missing = games.filter((game) => !game.packageAvailable).length
  if (missing > 0) {
    return {
      label: missing === 1 ? '1 paquete ausente' : `${missing} paquetes ausentes`,
      tone: 'danger'
    }
  }
  const warnings = games.filter((game) => Boolean(game.packageProblem)).length
  if (warnings > 0) {
    return {
      label: warnings === 1 ? '1 paquete con avisos' : `${warnings} paquetes con avisos`,
      tone: 'warn'
    }
  }
  return { label: 'Paquetes al día', tone: 'ok' }
}

export function steamSyncLabel(game: CatalogGame): string {
  if (game.steam.syncState === 'synced' || game.steam.syncState === 'pending') {
    return 'Sincronizar con Steam'
  }
  if (game.steam.syncState === 'failed') return 'Añadir a Steam de nuevo'
  return 'Añadir a Steam'
}
