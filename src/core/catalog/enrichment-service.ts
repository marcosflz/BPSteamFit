import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ArtworkGalleryItem,
  ArtworkKind,
  ArtworkView,
  CatalogGame,
  GameMetadata,
  IdentityState,
  ProviderStatus
} from '@shared/domain'
import { ARTWORK_KINDS } from '@shared/domain'
import { AppError, isAppError } from '@shared/errors'
import type { Manifest } from '@shared/manifest'
import { MockMetadataProvider } from '../metadata/mock-provider'
import { SteamGridDbProvider } from '../metadata/steamgriddb-provider'
import { MetadataService } from '../metadata/service'
import {
  confirmIdentity,
  hintsFromManifest,
  identityCandidateFromProvider,
  IdentityService,
  isIdentityResolved,
  queryFromManifest
} from '../metadata/identity-service'
import type { ArtworkCandidate, MetadataCache, MetadataProvider } from '../metadata/types'
import { filterSafeCandidates } from '../metadata/matching'
import { ArtworkIngestor } from '../artwork/ingest'
import { rankArtworkCandidates } from '../artwork/ranking'
import { sha256Bytes } from '../artwork/variants'
import type { IngestedArtwork } from '../artwork/types'
import { artworkRowToView, type ArtworkRepository } from '../storage/artwork-repository'
import type { FileArtworkStorage } from '../storage/artwork-storage'
import type { CatalogRepository } from '../storage/catalog-repository'
import type { SettingsRepository } from '../storage/settings-repository'
import { parseGame, parsePackage } from '../storage/parsers'
import type { FileLog } from '../logging/install-log'
import { getCatalogGame } from './catalog-mapper'

const AUTO_ARTWORK_KINDS: readonly ArtworkKind[] = ['portrait', 'hero', 'logo', 'icon']
const GALLERY_KINDS: readonly ArtworkKind[] = ARTWORK_KINDS
const MAX_GALLERY_CANDIDATES = 8
const MAX_LOCAL_ARTWORK_BYTES = 20 * 1024 * 1024

export interface EnrichmentOptions {
  catalog: CatalogRepository
  artwork: ArtworkRepository
  artworkStorage: FileArtworkStorage
  cache: MetadataCache
  settings: SettingsRepository
  log: FileLog
  getSteamGridDbKey: () => string | null
  onChanged?: (reason: string, gameId?: string) => void
}

interface ProviderState {
  providerId: 'mock' | 'steamgriddb'
  language: 'es' | 'en'
  keyFingerprint: string
  metadata: MetadataService
  identity: IdentityService
  ingestor: ArtworkIngestor
  provider: MetadataProvider
}

function keyFingerprint(key: string | null): string {
  const value = key ?? ''
  return `${value.length}:${value.slice(0, 2)}:${value.slice(-2)}`
}

function copyMetadata(metadata: GameMetadata): GameMetadata {
  return structuredClone(metadata)
}

/**
 * Coordina proveedor + identidad + metadatos + artwork con la base local.
 * Todo fallo de red se registra y no bloquea el catálogo ni la instalación.
 */
export class EnrichmentService {
  private state: ProviderState | null = null
  private epoch = 0
  private readonly autoInFlight = new Map<string, Promise<void>>()
  private readonly autoQueued = new Set<string>()
  private readonly kindInFlight = new Map<string, Promise<ArtworkView[]>>()

  constructor(private readonly options: EnrichmentOptions) {}

  private ensureProvider(): ProviderState {
    const settings = this.options.settings.get()
    const providerId = settings.metadataProvider
    const language: 'es' | 'en' = settings.referToMetadataInSpanish ? 'es' : 'en'
    let key: string | null = null
    if (providerId === 'steamgriddb') {
      try {
        key = this.options.getSteamGridDbKey()
      } catch (error) {
        this.options.log.warn(
          `No se pudo leer la clave de SteamGridDB: ${error instanceof Error ? error.message : String(error)}`
        )
        key = null
      }
    }
    const fingerprint = keyFingerprint(key)
    if (
      this.state &&
      this.state.providerId === providerId &&
      this.state.language === language &&
      this.state.keyFingerprint === fingerprint
    ) {
      return this.state
    }

    let provider: MetadataProvider
    if (providerId === 'steamgriddb') {
      provider = new SteamGridDbProvider({
        apiKey: key ?? '',
        timeoutMs: 8_000,
        maxRetries: 2
      })
    } else {
      provider = new MockMetadataProvider({ language })
    }
    const metadata = new MetadataService({
      provider,
      cache: this.options.cache,
      language
    })
    const identity = new IdentityService({ service: metadata })
    const ingestor = new ArtworkIngestor({
      storage: this.options.artworkStorage,
      maxBytes: 15 * 1024 * 1024,
      maxPixels: 40_000_000,
      allowDataUrls: true
    })
    this.state = {
      providerId,
      language,
      keyFingerprint: fingerprint,
      metadata,
      identity,
      ingestor,
      provider
    }
    this.epoch += 1
    this.options.log.info(`Proveedor de metadatos activo: ${providerId} (${language})`)
    return this.state
  }

  invalidateProvider(): void {
    this.state = null
    this.epoch += 1
  }

  private ensureEpoch(epoch: number): void {
    if (epoch !== this.epoch) {
      throw new AppError(
        'METADATA_PROVIDER_FAILED',
        'La configuración del proveedor cambió durante la actualización; se descartó el resultado anterior.'
      )
    }
  }

  getProviderStatus(): ProviderStatus {
    const state = this.ensureProvider()
    return state.metadata.getStatus()
  }

  getProviderId(): string {
    return this.ensureProvider().provider.info.id
  }

  private notify(reason: string, gameId?: string): void {
    try {
      this.options.onChanged?.(reason, gameId)
    } catch {
      // La UI no debe romper el pipeline.
    }
  }

  private getContext(gameId: string): {
    aggregate: NonNullable<ReturnType<CatalogRepository['getAggregate']>>
    manifest: Manifest
    parsedGame: ReturnType<typeof parseGame>
  } {
    const aggregate = this.options.catalog.getAggregate(gameId)
    if (!aggregate?.currentPackage) {
      throw new AppError('PACKAGE_NOT_FOUND', 'El juego o su paquete actual no existen.')
    }
    return {
      aggregate,
      manifest: parsePackage(aggregate.currentPackage).manifest,
      parsedGame: parseGame(aggregate.game)
    }
  }

  private providerMismatch(identity: IdentityState, providerId: string): boolean {
    return Boolean(identity.provider && identity.provider !== providerId)
  }

  private resetIdentityForProvider(identity: IdentityState, providerId: string): IdentityState {
    return {
      status: 'none',
      provider: providerId,
      candidates: [],
      updatedAt: new Date().toISOString(),
      message: 'El proveedor de metadatos cambió; la identidad anterior no se reutiliza.'
    }
  }

  /**
   * Punto de entrada en segundo plano tras importar. No debe lanzar al llamador.
   */
  enqueueAuto(gameId: string): void {
    if (this.autoInFlight.has(gameId)) {
      this.autoQueued.add(gameId)
      return
    }
    const task = (async () => {
      try {
        await this.refresh(gameId, {
          forceIdentity: false,
          forceDetails: false,
          forceArtwork: false,
          auto: true
        })
      } catch (error) {
        this.options.log.warn(
          `No se pudieron obtener metadatos/artwork para ${gameId}: ${isAppError(error) ? error.message : String(error)}`
        )
      }
    })().finally(() => {
      this.autoInFlight.delete(gameId)
      if (this.autoQueued.delete(gameId)) {
        this.enqueueAuto(gameId)
      }
    })
    this.autoInFlight.set(gameId, task)
  }

  async refresh(
    gameId: string,
    options: {
      forceIdentity?: boolean
      forceDetails?: boolean
      forceArtwork?: boolean
      auto?: boolean
      artworkKinds?: readonly ArtworkKind[]
      signal?: AbortSignal
    } = {}
  ): Promise<CatalogGame> {
    const state = this.ensureProvider()
    const epoch = this.epoch
    const { manifest, parsedGame } = this.getContext(gameId)
    let identity = parsedGame.identity
    let metadata = parsedGame.metadata
    let clearedProviderArtwork = false

    if (this.providerMismatch(identity, state.provider.info.id)) {
      identity = this.resetIdentityForProvider(identity, state.provider.info.id)
      metadata = null
      this.options.catalog.setIdentity(gameId, identity)
      this.options.catalog.setMetadataAndIdentity(gameId, null, identity)
      if (this.options.artwork.listViews(gameId).some((view) => view.source === 'provider')) {
        this.options.artwork.removeProviderArtwork(gameId)
        clearedProviderArtwork = true
      }
    }

    const userSkipped =
      identity.status === 'none' && identity.decidedBy === 'user'
    const shouldResolve =
      options.forceIdentity === true ||
      (!userSkipped && !isIdentityResolved(identity) && identity.status !== 'ambiguous')

    if (shouldResolve) {
      const hints = {
        ...hintsFromManifest(manifest.metadata),
        providerIds: {
          ...(manifest.metadata?.providerIds ?? {}),
          ...parsedGame.providerIds
        }
      }
      const resolution = await state.identity.resolve({
        query: queryFromManifest(manifest.metadata, parsedGame.name),
        hints,
        signal: options.signal,
        forceRefresh: options.forceIdentity ?? false
      })
      this.ensureEpoch(epoch)
      identity = resolution.state
      if (resolution.warning) this.options.log.warn(resolution.warning)
      if (resolution.error) {
        this.options.log.warn(
          `Identidad de ${gameId}: ${resolution.error.code}: ${resolution.error.message}`
        )
      }
      if (isIdentityResolved(identity)) {
        const details = await state.identity.metadataFor(identity, {
          signal: options.signal,
          forceRefresh: options.forceDetails ?? false
        })
        this.ensureEpoch(epoch)
        if (details.data) {
          metadata = copyMetadata(details.data)
        } else if (details.warning) {
          this.options.log.warn(details.warning)
        }
      } else {
        metadata = null
      }
      this.ensureEpoch(epoch)
      this.options.catalog.setMetadataAndIdentity(gameId, metadata, identity)
      this.options.log.info(
        `Identidad ${gameId}: ${identity.status}${identity.providerId ? ` (${identity.providerId})` : ''}.`
      )
      this.notify('metadata', gameId)
    } else {
      const languageOutdated = Boolean(
        metadata?.language && metadata.language !== state.language
      )
      if ((options.forceDetails || languageOutdated) && isIdentityResolved(identity)) {
        const details = await state.identity.metadataFor(identity, {
          signal: options.signal,
          forceRefresh: true
        })
        this.ensureEpoch(epoch)
        if (details.data) {
          metadata = copyMetadata(details.data)
          this.options.catalog.setMetadataAndIdentity(gameId, metadata, identity)
          this.notify('metadata', gameId)
        } else if (details.warning) {
          this.options.log.warn(details.warning)
        }
      }
      this.ensureEpoch(epoch)
      this.options.catalog.setMetadataAndIdentity(gameId, metadata, identity)
    }

    if (clearedProviderArtwork) this.notify('artwork', gameId)

    if (isIdentityResolved(identity) && identity.providerId) {
      const kinds = options.artworkKinds ?? AUTO_ARTWORK_KINDS
      for (const kind of kinds) {
        if (!AUTO_ARTWORK_KINDS.includes(kind) && options.auto) continue
        try {
          await this.ensureAutoArtworkKind(
            gameId,
            state,
            identity,
            kind,
            options.forceArtwork ?? false,
            epoch
          )
        } catch (error) {
          this.options.log.warn(
            `Artwork ${kind} de ${gameId} no disponible: ${isAppError(error) ? error.message : String(error)}`
          )
        }
      }
      this.notify('artwork', gameId)
    }

    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  async refreshManual(gameId: string): Promise<CatalogGame> {
    const aggregate = this.options.catalog.getAggregate(gameId)
    if (!aggregate) throw new AppError('PACKAGE_NOT_FOUND', 'El juego no existe en el catálogo.')
    const identity = parseGame(aggregate.game).identity
    const resolved = isIdentityResolved(identity)
    return this.refresh(gameId, {
      forceIdentity: !resolved,
      forceDetails: true,
      forceArtwork: true
    })
  }

  async searchIdentity(gameId: string, query: string): Promise<CatalogGame> {
    const state = this.ensureProvider()
    const epoch = this.epoch
    const { manifest, parsedGame } = this.getContext(gameId)
    const trimmed = query.trim()
    if (!trimmed) throw new AppError('VALIDATION_ERROR', 'Introduce un título para buscar.')
    const lookup = await state.metadata.search(
      trimmed,
      {
        ...hintsFromManifest(manifest.metadata),
        providerIds: parsedGame.providerIds
      },
      { forceRefresh: true }
    )
    this.ensureEpoch(epoch)
    const safe = filterSafeCandidates(lookup.data ?? [])
    const candidates = safe.map(identityCandidateFromProvider)
    const identity: IdentityState = {
      status: candidates.length > 0 ? 'ambiguous' : 'none',
      provider: state.provider.info.id,
      candidates,
      updatedAt: new Date().toISOString(),
      decidedBy: 'user',
      message:
        candidates.length > 0
          ? `Resultados de ${state.provider.info.name}. Elige una identidad para evitar asociaciones incorrectas.`
          : lookup.error?.message ?? 'La búsqueda no devolvió resultados.'
    }
    this.options.catalog.setMetadataAndIdentity(gameId, null, identity)
    this.options.artwork.removeProviderArtwork(gameId)
    this.notify('identity', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  async chooseIdentity(gameId: string, candidateKey: string): Promise<CatalogGame> {
    const state = this.ensureProvider()
    const epoch = this.epoch
    const { parsedGame } = this.getContext(gameId)
    const candidate = parsedGame.identity.candidates.find((entry) => entry.key === candidateKey)
    if (!candidate) {
      throw new AppError('VALIDATION_ERROR', 'El candidato ya no está disponible. Busca de nuevo.')
    }
    if (candidate.provider !== state.provider.info.id) {
      throw new AppError(
        'VALIDATION_ERROR',
        'El candidato pertenece a otro proveedor. No se mezclan identidades.'
      )
    }
    const identity = confirmIdentity(parsedGame.identity, candidate)
    this.options.catalog.setMetadataAndIdentity(gameId, null, identity)
    this.options.artwork.removeProviderArtwork(gameId)
    this.notify('identity', gameId)

    const details = await state.identity.metadataFor(identity, { forceRefresh: false })
    this.ensureEpoch(epoch)
    if (details.data) {
      this.options.catalog.setMetadataAndIdentity(gameId, details.data, identity)
      this.notify('metadata', gameId)
    } else if (details.error) {
      this.options.log.warn(
        `No se pudieron cargar detalles de ${candidate.title}: ${details.error.message}`
      )
    }
    for (const kind of AUTO_ARTWORK_KINDS) {
      try {
        await this.ensureAutoArtworkKind(gameId, state, identity, kind, true, epoch)
      } catch (error) {
        this.options.log.warn(
          `Artwork de ${kind} para ${gameId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    this.notify('artwork', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  async clearIdentity(gameId: string): Promise<CatalogGame> {
    const { parsedGame } = this.getContext(gameId)
    const identity: IdentityState = {
      ...parsedGame.identity,
      status: 'none',
      providerId: undefined,
      title: undefined,
      releaseYear: undefined,
      decidedBy: 'user',
      updatedAt: new Date().toISOString(),
      message: 'Sin metadatos por elección del usuario. Usa "Actualizar metadatos" para volver a buscar.'
    }
    this.options.catalog.setMetadataAndIdentity(gameId, null, identity)
    this.options.artwork.removeProviderArtwork(gameId)
    this.notify('identity', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  private async ingestCandidate(
    gameId: string,
    state: ProviderState,
    candidate: ArtworkCandidate,
    epoch: number
  ): Promise<ArtworkView> {
    const existing = this.options.artwork.findByProviderAsset(
      gameId,
      candidate.kind,
      candidate.provider,
      candidate.providerAssetId
    )
    if (existing) {
      this.ensureEpoch(epoch)
      return artworkRowToView(existing)
    }
    const ingested: IngestedArtwork = await state.ingestor.ingest(candidate)
    this.ensureEpoch(epoch)
    const originalKey = ingested.original.storageKey
    const variantKey = ingested.variant.storageKey
    if (!originalKey || !variantKey) {
      throw new AppError('ARTWORK_INVALID', 'El artwork no se guardó en el almacenamiento local.')
    }
    const assetId = `${gameId}:${candidate.provider}:${candidate.providerAssetId}`
    return this.options.artwork.upsert({
      id: assetId,
      gameId,
      kind: candidate.kind,
      provider: candidate.provider,
      providerGameId: candidate.providerGameId,
      providerAssetId: candidate.providerAssetId,
      remoteUrl: candidate.url,
      originalKey,
      variantKey,
      width: ingested.variant.width,
      height: ingested.variant.height,
      bytes: ingested.original.byteLength,
      contentType: ingested.original.mime,
      source: 'provider',
      author: candidate.author,
      attribution: candidate.attribution,
      license: candidate.license
    })
  }

  private async ensureAutoArtworkKind(
    gameId: string,
    state: ProviderState,
    identity: IdentityState,
    kind: ArtworkKind,
    force: boolean,
    epoch: number
  ): Promise<ArtworkView | null> {
    if (!identity.providerId) return null
    this.ensureEpoch(epoch)
    const current = this.options.artwork.getChosenRow(gameId, kind)
    if (current?.source === 'manual') return this.options.artwork.getChosenViews(gameId)[kind] ?? null
    if (
      current &&
      !force &&
      current.provider === state.provider.info.id &&
      current.provider_game_id === identity.providerId
    ) {
      return this.options.artwork.getChosenViews(gameId)[kind] ?? null
    }

    const lookup = await state.metadata.listArtwork(identity.providerId, kind, {
      forceRefresh: force,
      limit: 12
    })
    this.ensureEpoch(epoch)
    if (!lookup.data || lookup.data.length === 0) {
      if (lookup.warning) this.options.log.warn(lookup.warning)
      return null
    }
    const ranked = rankArtworkCandidates(lookup.data, kind)
    let lastError: unknown = null
    for (const entry of ranked.slice(0, 4)) {
      try {
        this.ensureEpoch(epoch)
        const view = await this.ingestCandidate(gameId, state, entry.candidate, epoch)
        this.ensureEpoch(epoch)
        const chosen = this.options.artwork.chooseAutomatic(gameId, kind, view.id)
        this.options.log.info(`Artwork ${kind} elegido para ${gameId} (${entry.candidate.provider}).`)
        return chosen
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) {
      this.options.log.warn(
        `Ningún artwork ${kind} se pudo guardar: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      )
    }
    return null
  }

  async artworkGallery(gameId: string, kind: ArtworkKind): Promise<ArtworkGalleryItem[]> {
    const state = this.ensureProvider()
    const epoch = this.epoch
    if (!GALLERY_KINDS.includes(kind)) {
      throw new AppError('VALIDATION_ERROR', 'Tipo de artwork no válido.')
    }
    const { parsedGame } = this.getContext(gameId)
    const identity = parsedGame.identity
    const key = `${gameId}:${kind}`
    const existingPromise = this.kindInFlight.get(key)
    if (existingPromise) {
      const views = await existingPromise
      return views.map((view) => ({ ...view, selected: view.chosen }))
    }

    const task = (async (): Promise<ArtworkView[]> => {
      if (isIdentityResolved(identity) && identity.providerId) {
        try {
          await this.ensureAutoArtworkKind(gameId, state, identity, kind, false, epoch)
          const lookup = await state.metadata.listArtwork(identity.providerId, kind, {
            forceRefresh: false,
            limit: 20
          })
          this.ensureEpoch(epoch)
          const ranked = rankArtworkCandidates(lookup.data ?? [], kind)
          for (const entry of ranked.slice(0, MAX_GALLERY_CANDIDATES)) {
            this.ensureEpoch(epoch)
            const existing = this.options.artwork.findByProviderAsset(
              gameId,
              kind,
              entry.candidate.provider,
              entry.candidate.providerAssetId
            )
            if (existing) continue
            try {
              await this.ingestCandidate(gameId, state, entry.candidate, epoch)
            } catch (error) {
              this.options.log.warn(
                `No se pudo cachear una imagen de galería (${kind}): ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
        } catch (error) {
          if (this.options.artwork.listViews(gameId, kind).length === 0) throw error
          this.options.log.warn(
            `Galería de ${kind} servida desde caché local: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      return this.options.artwork.listViews(gameId, kind)
    })().finally(() => {
      this.kindInFlight.delete(key)
    })
    this.kindInFlight.set(key, task)
    const views = await task
    this.notify('artwork', gameId)
    return views
      .map((view) => ({ ...view, selected: view.chosen }))
      .sort((left, right) => Number(right.selected) - Number(left.selected))
  }

  private markSteamPending(gameId: string): void {
    const aggregate = this.options.catalog.getAggregate(gameId)
    if (!aggregate?.install) return
    if (aggregate.install.state !== 'installed') return
    const parsed = parseGame(aggregate.game)
    if (!parsed.steam.enabled) return
    this.options.catalog.setSteamGameState(gameId, {
      ...parsed.steam,
      syncState: 'pending'
    })
  }

  async selectArtwork(
    gameId: string,
    kind: ArtworkKind,
    assetId: string
  ): Promise<CatalogGame> {
    this.getContext(gameId)
    this.options.artwork.choose(gameId, kind, assetId, 'manual')
    this.markSteamPending(gameId)
    this.notify('artwork', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  async importLocalArtwork(
    gameId: string,
    kind: ArtworkKind,
    filePath: string
  ): Promise<CatalogGame> {
    if (!GALLERY_KINDS.includes(kind)) {
      throw new AppError('VALIDATION_ERROR', 'Tipo de artwork no válido.')
    }
    const { parsedGame } = this.getContext(gameId)
    const state = this.ensureProvider()
    const epoch = this.epoch
    const extension = path.extname(filePath).toLowerCase()
    const mime =
      extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.webp'
            ? 'image/webp'
            : null
    if (!mime) {
      throw new AppError('ARTWORK_INVALID', 'Formato no admitido. Usa PNG, JPEG o WebP.')
    }
    const bytes = await readFile(filePath).catch((error) => {
      throw new AppError('ARTWORK_INVALID', 'No se pudo leer la imagen seleccionada.', {
        cause: error instanceof Error ? error.message : String(error)
      })
    })
    if (bytes.byteLength > MAX_LOCAL_ARTWORK_BYTES) {
      throw new AppError('ARTWORK_TOO_LARGE', 'La imagen local supera 20 MB.')
    }
    const sha = sha256Bytes(bytes)
    const candidate: ArtworkCandidate = {
      provider: 'local',
      providerAssetId: `${sha}:${kind}`,
      providerGameId: parsedGame.identity.providerId ?? 'local',
      kind,
      url: `data:${mime};base64,${bytes.toString('base64')}`,
      width: undefined,
      height: undefined,
      style: 'local',
      language: state.language,
      author: 'Usuario',
      license: 'Archivo local elegido por el usuario',
      tags: [],
      createdAt: new Date().toISOString(),
      isMock: false
    }
    const view = await this.ingestCandidate(gameId, state, candidate, epoch)
    this.ensureEpoch(epoch)
    this.options.artwork.choose(gameId, kind, view.id, 'manual')
    this.markSteamPending(gameId)
    this.notify('artwork', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  async resetArtwork(gameId: string, kind: ArtworkKind): Promise<CatalogGame> {
    const state = this.ensureProvider()
    const epoch = this.epoch
    const { parsedGame } = this.getContext(gameId)
    this.options.artwork.clearChoice(gameId, kind)
    if (isIdentityResolved(parsedGame.identity) && parsedGame.identity.providerId) {
      try {
        await this.ensureAutoArtworkKind(gameId, state, parsedGame.identity, kind, true, epoch)
      } catch (error) {
        this.options.log.warn(
          `No se pudo restaurar artwork automático: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    this.markSteamPending(gameId)
    this.notify('artwork', gameId)
    const updated = this.options.catalog.getAggregate(gameId)
    if (!updated) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
    return requireCatalogGame(updated)
  }

  getMediaStorageKey(assetId: string, variant = 'preview'): string | null {
    return variant === 'original'
      ? this.options.artwork.getOriginalKey(assetId)
      : this.options.artwork.getPreviewKey(assetId)
  }
}

function requireCatalogGame(
  aggregate: NonNullable<ReturnType<CatalogRepository['getAggregate']>>
): CatalogGame {
  const game = getCatalogGame(aggregate)
  if (!game) throw new AppError('PACKAGE_NOT_FOUND', 'El juego desapareció del catálogo.')
  return game
}
