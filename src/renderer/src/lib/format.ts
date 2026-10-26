import type { InstallerProfile } from '@shared/manifest'
import type { ArtworkKind, InstallState } from '@shared/domain'

const byteFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })
const percentFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })

export function formatBytes(value: number | undefined | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value / 1024
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${byteFormatter.format(amount)} ${units[unit] ?? 'TiB'}`
}

export function formatPercent(value: number | undefined | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const clamped = Math.min(100, Math.max(0, value))
  return `${percentFormatter.format(clamped)} %`
}

export function formatDateTime(value: string | undefined | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  } catch {
    return null
  }
}

export function formatCount(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}

export function initials(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
}

/** Tono estable derivado del título; evita que todos los placeholders se vean igual. */
export function placeholderHue(title: string): number {
  let hash = 0
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360
  }
  return hash
}

export const ARTWORK_LABELS: Record<ArtworkKind, string> = {
  portrait: 'Portada',
  hero: 'Fondo',
  logo: 'Logo',
  icon: 'Icono',
  screenshot: 'Capturas'
}

export const INSTALL_STATE_LABELS: Record<InstallState, string> = {
  available: 'Disponible',
  validating: 'Validando',
  extracting: 'Extrayendo',
  installing: 'Instalando',
  verifying: 'Verificando',
  installed: 'Instalado',
  reboot_pending: 'Reinicio pendiente',
  failed: 'Fallo',
  cancelled: 'Cancelado',
  interrupted: 'Interrumpido'
}

export const INSTALLER_PROFILE_LABELS: Record<InstallerProfile, string> = {
  generic: 'Genérico',
  inno: 'Inno Setup',
  nsis: 'NSIS',
  demo: 'Demostración'
}

export function installStateIsActive(state: InstallState): boolean {
  return ['validating', 'extracting', 'installing', 'verifying'].includes(state)
}

export function installStateIsTerminal(state: InstallState): boolean {
  return ['installed', 'reboot_pending', 'failed', 'cancelled', 'interrupted'].includes(state)
}

/**
 * Solo se permiten recursos locales servidos por el protocolo de la app o datos
 * embebidos. Nunca se carga artwork remoto directamente desde la interfaz.
 */
export function safeArtworkUrl(url: string | undefined | null): string | null {
  if (!url) return null
  if (url.startsWith('bps-media:')) return url
  if (url.startsWith('data:image/')) return url
  return null
}
