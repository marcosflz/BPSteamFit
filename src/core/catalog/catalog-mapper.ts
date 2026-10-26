import type { ArtworkSet, CatalogGame, InstallSnapshot, SteamGameState } from '@shared/domain'
import { parseGame, parseInstall, parsePackage } from '../storage/parsers'
import type { GameAggregate } from '../storage/types'

/** Convierte filas SQLite en el contrato de catálogo que consume la UI. */
export function getCatalogGame(aggregate: GameAggregate): CatalogGame | null {
  const { game, currentPackage, packages, install } = aggregate
  if (!currentPackage) return null
  const parsedGame = parseGame(game)
  const parsedPackage = parsePackage(currentPackage)
  const installedPackage =
    install && (install.state === 'installed' || install.state === 'reboot_pending')
      ? packages.find((row) => row.key === install.package_key) ?? null
      : null
  const snapshot: InstallSnapshot = parseInstall(install) ?? {
    state: 'available',
    installDir: undefined
  }

  const installed = snapshot.state === 'installed' || snapshot.state === 'reboot_pending'
  let syncState: SteamGameState['syncState'] = parsedGame.steam.syncState
  if (!installed) {
    syncState = 'not_installed'
  } else if (!parsedGame.steam.enabled) {
    syncState = 'none'
  } else if (syncState === 'none') {
    syncState = 'pending'
  }

  return {
    id: parsedGame.id,
    name: parsedGame.name,
    edition: parsedGame.edition,
    currentVersion: currentPackage.version,
    packageKey: currentPackage.key,
    installedVersion: installedPackage?.version,
    installedPackageKey: installedPackage?.key,
    packagePath: currentPackage.file_path,
    packageAvailable: currentPackage.available === 1,
    packageProblem: currentPackage.problem ?? undefined,
    packageSize: currentPackage.file_size,
    availableVersions: [...packages]
      .sort(
        (a, b) => b.imported_at.localeCompare(a.imported_at) || b.version.localeCompare(a.version)
      )
      .map((row) => ({
        key: row.key,
        version: row.version,
        available: row.available === 1,
        importedAt: row.imported_at,
        problem: row.problem ?? undefined
      })),
    installerProfile: parsedPackage.manifest.installation.profile,
    requiresElevation: parsedPackage.manifest.installation.requiresElevation,
    install: snapshot,
    identity: parsedGame.identity,
    metadata: parsedGame.metadata,
    artwork: (parsedGame.artwork ?? {}) as ArtworkSet,
    steam: {
      ...parsedGame.steam,
      displayName: parsedGame.steam.displayName || parsedGame.name,
      tags: parsedGame.steam.tags ?? [],
      syncState
    },
    updatedAt: parsedGame.updated_at
  }
}
