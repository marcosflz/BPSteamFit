import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { InstallProgress, VerificationSnapshot } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { Manifest } from '@shared/manifest'
import { checkRelativePath, isPathInside } from '@shared/safe-path'

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export interface VerificationOptions {
  timeoutMs: number
  pollIntervalMs?: number
  stableWindowMs?: number
  onProgress?: (progress: InstallProgress) => void
}

interface Presence {
  ok: boolean
  missingFiles: string[]
  missingDirectories: string[]
  sizes: Map<string, number>
  invalid: string[]
}

export async function checkInstallationPresence(
  installDir: string,
  manifest: Pick<Manifest, 'installation'>
): Promise<Presence> {
  const base = path.resolve(installDir)
  const requiredFiles = manifest.installation.verification.requiredFiles
  const requiredDirectories = manifest.installation.verification.requiredDirectories
  const missingFiles: string[] = []
  const missingDirectories: string[] = []
  const invalid: string[] = []
  const sizes = new Map<string, number>()

  for (const relative of requiredFiles) {
    const checked = checkRelativePath(relative, { label: 'Un archivo de verificación' })
    if (!checked.ok) {
      invalid.push(checked.reason)
      continue
    }
    const target = path.resolve(base, ...checked.value.split('/'))
    if (!isPathInside(base, target)) {
      invalid.push(`La ruta de verificación escapa del destino: ${relative}`)
      continue
    }
    try {
      const stats = await lstat(target)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        invalid.push(`${relative} existe, pero no es un archivo regular.`)
        missingFiles.push(relative)
      } else if (stats.size === 0) {
        invalid.push(`${relative} existe pero está vacío.`)
        missingFiles.push(relative)
      } else {
        sizes.set(relative, stats.size)
      }
    } catch {
      missingFiles.push(relative)
    }
  }

  for (const relative of requiredDirectories) {
    const checked = checkRelativePath(relative, { label: 'Un directorio de verificación' })
    if (!checked.ok) {
      invalid.push(checked.reason)
      continue
    }
    const target = path.resolve(base, ...checked.value.split('/'))
    if (!isPathInside(base, target)) {
      invalid.push(`La ruta de verificación escapa del destino: ${relative}`)
      continue
    }
    try {
      const stats = await lstat(target)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        invalid.push(`${relative} existe, pero no es un directorio regular.`)
        missingDirectories.push(relative)
      }
    } catch {
      missingDirectories.push(relative)
    }
  }

  return {
    ok: missingFiles.length === 0 && missingDirectories.length === 0 && invalid.length === 0,
    missingFiles,
    missingDirectories,
    sizes,
    invalid
  }
}

/**
 * Verifica los archivos finales sin asumir que el primer proceso es el único
 * que escribe. Espera a que existan y a que sus tamaños se mantengan estables
 * durante una ventana corta. No usa nombres genéricos de procesos.
 */
export async function verifyInstallation(
  installDir: string,
  manifest: Pick<Manifest, 'installation'>,
  options: VerificationOptions
): Promise<VerificationSnapshot> {
  const deadline = Date.now() + options.timeoutMs
  const pollInterval = options.pollIntervalMs ?? 400
  const stableWindow = options.stableWindowMs ?? 600
  let last: Presence | null = null
  let stableCandidate: { at: number; sizes: Map<string, number> } | null = null

  while (Date.now() <= deadline) {
    last = await checkInstallationPresence(installDir, manifest)
    if (last.ok) {
      if (!stableCandidate) {
        stableCandidate = { at: Date.now(), sizes: new Map(last.sizes) }
      } else {
        const same =
          stableCandidate.sizes.size === last.sizes.size &&
          [...last.sizes.entries()].every(([file, size]) => stableCandidate?.sizes.get(file) === size)
        if (Date.now() - stableCandidate.at >= stableWindow && same) {
          return {
            ok: true,
            checkedAt: new Date().toISOString(),
            missingFiles: [],
            missingDirectories: []
          }
        }
      }
    } else {
      stableCandidate = null
    }
    options.onProgress?.({
      phase: 'Verificando los archivos instalados',
      indeterminate: true
    })
    await sleep(pollInterval)
  }

  if (!last) last = await checkInstallationPresence(installDir, manifest)
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    missingFiles: last.missingFiles,
    missingDirectories: last.missingDirectories
  }
}

/** Verificación puntual para el arranque o el botón "Comprobar instalación". */
export async function verifyInstalledFiles(
  installDir: string,
  manifest: Pick<Manifest, 'installation'>
): Promise<VerificationSnapshot> {
  const presence = await checkInstallationPresence(installDir, manifest)
  return {
    ok: presence.ok,
    checkedAt: new Date().toISOString(),
    missingFiles: presence.missingFiles,
    missingDirectories: presence.missingDirectories
  }
}
