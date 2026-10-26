import { useRef, type CSSProperties } from 'react'
import type { CatalogGame } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ArtworkVisual } from '../components/ArtworkVisual'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusChip } from '../components/StatusChip'
import { AlertIcon, ArrowLeftIcon, FolderIcon, GamepadIcon, ImageIcon, PlayIcon, RefreshIcon } from '../components/icons'
import { formatBytes, formatDateTime, INSTALLER_PROFILE_LABELS, installStateIsActive, safeArtworkUrl } from '../lib/format'
import { fromSerializedError } from '../lib/errors'
import {
  installStatus,
  packageIssue,
  steamStatus,
  steamSyncLabel
} from '../lib/status'

function identityLabel(game: CatalogGame): string {
  switch (game.identity.status) {
    case 'confirmed':
      return 'Identidad confirmada'
    case 'auto':
      return 'Identidad automática'
    case 'ambiguous':
      return 'Varios candidatos'
    default:
      return 'Sin identidad'
  }
}

function steamStateLabel(game: CatalogGame): string {
  switch (game.steam.syncState) {
    case 'pending':
      return 'Cambios pendientes'
    case 'failed':
      return 'La última sincronización falló'
    case 'synced':
      return 'Sincronizado'
    case 'not_installed':
      return 'Pendiente de instalar'
    default:
      return 'Sin cambios'
  }
}

export function GameScreen(props: { game: CatalogGame }): React.JSX.Element {
  const { game } = props
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, `game:${game.id}`)
  useScreenControls({ onBack: () => runtime.back() })

  const displayTitle = game.metadata?.title ?? game.identity.title ?? game.name
  const status = installStatus(game)
  const steam = steamStatus(game)
  const issue = packageIssue(game)
  const install = game.install
  const active = installStateIsActive(install.state)
  const installed = install.state === 'installed'
  const canInstall = ['available', 'failed', 'cancelled', 'interrupted'].includes(install.state)
  const heroUrl = safeArtworkUrl(game.artwork.hero?.previewUrl)
  const logoUrl = safeArtworkUrl(game.artwork.logo?.previewUrl)
  const portraitUrl = safeArtworkUrl(game.artwork.portrait?.previewUrl)
  const packageSize = formatBytes(game.packageSize)
  const installError = fromSerializedError(install.error)
  const updated = formatDateTime(game.updatedAt)

  const heroStyle: CSSProperties | undefined = heroUrl
    ? { backgroundImage: `linear-gradient(90deg, rgba(7,11,17,.96) 0%, rgba(7,11,17,.72) 48%, rgba(7,11,17,.28) 100%), url("${heroUrl.replaceAll('"', '%22')}")` }
    : undefined

  const runAction = async (task: () => Promise<unknown>, success: string): Promise<void> => {
    const result = await run(task)
    if (result.ok) runtime.toast('success', success)
    else runtime.toast('error', result.error.message)
  }

  const installGame = (): void => runtime.openDialog({ kind: 'install', gameId: game.id })

  const launch = (): void => {
    void runAction(() => runtime.api.launchGame(game.id), `Lanzamiento solicitado: ${game.name}.`)
  }

  const revalidate = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.revalidateInstall(game.id))
      if (result.ok) {
        runtime.updateGame(result.value)
        const verification = result.value.install.verification
        if (verification && !verification.ok) {
          runtime.toast('error', 'La comprobación encontró archivos ausentes. Revisa el estado de la instalación.')
        } else {
          runtime.toast('success', 'Instalación comprobada.')
        }
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const openFolder = (): void => {
    void (async () => {
      const result = install.installDir
        ? await run(() => runtime.api.openPath(install.installDir as string, 'install-dir'))
        : await run(() => runtime.api.revealGame(game.id))
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  const primaryAction = (() => {
    if (installed) {
      return (
        <button
          type="button"
          className="btn btn--primary btn--large"
          data-focusable
          data-focus-id="game-play"
          data-autofocus
          onClick={launch}
          disabled={busy}
        >
          <PlayIcon /> Jugar
        </button>
      )
    }
    if (active || install.state === 'reboot_pending') {
      return (
        <button
          type="button"
          className="btn btn--primary btn--large"
          data-focusable
          data-focus-id="game-install-progress"
          data-autofocus
          onClick={() => runtime.navigate({ type: 'install', gameId: game.id })}
        >
          Ver instalación
        </button>
      )
    }
    if (canInstall) {
      return (
        <button
          type="button"
          className="btn btn--primary btn--large"
          data-focusable
          data-focus-id="game-install"
          data-autofocus
          onClick={installGame}
          disabled={busy || !game.packageAvailable}
          title={!game.packageAvailable ? 'El paquete no está disponible' : undefined}
        >
          {install.installDir ? 'Instalar aquí' : 'Instalar'}
        </button>
      )
    }
    return null
  })()

  return (
    <section
      ref={rootRef}
      className="screen game-screen"
      data-screen-root
      aria-labelledby="game-title"
    >
      <div className="game-hero" style={heroStyle}>
        <div className="game-hero__texture" aria-hidden="true" />
        <div className="game-hero__content">
          <div className="game-hero__copy">
            <button
              type="button"
              className="back-link"
              data-focusable
              data-focus-id="game-back-top"
              onClick={() => runtime.back()}
            >
              <ArrowLeftIcon width={18} height={18} /> Biblioteca
            </button>
            <div className="game-hero__chips">
              <StatusChip label={status.label} tone={status.tone} />
              {steam ? <StatusChip label={steam.label} tone={steam.tone} /> : null}
              {game.metadata?.isMock ? (
                <span className="demo-badge">Datos de demostración</span>
              ) : null}
              {game.packageProblem ? (
                <StatusChip label="Paquete con avisos" tone="warn" />
              ) : null}
            </div>
            {logoUrl ? <h1 id="game-title" className="sr-only">{displayTitle}</h1> : null}
            {logoUrl ? (
              <img className="game-hero__logo" src={logoUrl} alt={displayTitle} />
            ) : (
              <h1 id="game-title">{displayTitle}</h1>
            )}
            {game.edition ? <p className="game-hero__edition">{game.edition}</p> : null}
            <p className="game-hero__lede">
              {game.metadata?.shortDescription ??
                'Una ficha local de tu catálogo. Sin tienda, sin ruido: tu juego y su estado real.'}
            </p>
            <div className="game-hero__actions" aria-label="Acciones del juego">
              {primaryAction}
              {installed ? (
                <button
                  type="button"
                  className="btn btn--large"
                  data-focusable
                  data-focus-id="game-verify"
                  onClick={revalidate}
                  disabled={busy}
                >
                  <RefreshIcon width={18} height={18} /> Comprobar instalación
                </button>
              ) : null}
              {active || install.state === 'reboot_pending' ? (
                <button
                  type="button"
                  className="btn btn--large"
                  data-focusable
                  data-focus-id="game-install-secondary"
                  onClick={() => runtime.navigate({ type: 'install', gameId: game.id })}
                >
                  Abrir progreso
                </button>
              ) : null}
              {!installed && !active && ['failed', 'cancelled', 'interrupted'].includes(install.state) ? (
                <button
                  type="button"
                  className="btn btn--large"
                  data-focusable
                  data-focus-id="game-install-log"
                  onClick={() => runtime.navigate({ type: 'install', gameId: game.id })}
                >
                  Ver instalación
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--large"
                data-focusable
                data-focus-id="game-identity"
                onClick={() => runtime.navigate({ type: 'identity', gameId: game.id })}
              >
                Elegir identidad
              </button>
              <button
                type="button"
                className="btn btn--large"
                data-focusable
                data-focus-id="game-artwork"
                onClick={() => runtime.navigate({ type: 'artwork', gameId: game.id })}
              >
                <ImageIcon width={18} height={18} /> Elegir imágenes
              </button>
              {game.steam.enabled ? (
                <button
                  type="button"
                  className="btn btn--large"
                  data-focusable
                  data-focus-id="game-steam"
                  onClick={() => runtime.navigate({ type: 'steam' })}
                >
                  {steamSyncLabel(game)}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--large"
                data-focusable
                data-focus-id="game-folder"
                onClick={openFolder}
                disabled={busy}
              >
                <FolderIcon width={18} height={18} /> Abrir carpeta
              </button>
              <button
                type="button"
                className="btn btn--large btn--quiet"
                data-focusable
                data-focus-id="game-back"
                onClick={() => runtime.back()}
              >
                Volver
              </button>
            </div>
          </div>
          <div className="game-hero__poster">
            <ArtworkVisual
              title={displayTitle}
              kind="portrait"
              src={portraitUrl}
              alt={`Portada de ${displayTitle}`}
            />
            {installed ? (
              <div className="poster-action">
                <GamepadIcon width={18} height={18} />
                <span>Listo para jugar</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <ErrorBanner error={error} /> : null}
      {issue ? (
        <div className="notice notice--warning" role="status">
          <AlertIcon />
          <div>
            <strong>Problema con el paquete</strong>
            <p>{issue}</p>
          </div>
        </div>
      ) : null}
      {game.requiresElevation ? (
        <div className="notice notice--warning" role="status">
          <AlertIcon />
          <div>
            <strong>Este paquete requiere elevación</strong>
            <p>
              La app no puede controlar el escritorio seguro de UAC con el mando. La instalación
              automática puede rechazarse; en ese caso ejecuta el setup manualmente y usa
              «Comprobar instalación».
            </p>
          </div>
        </div>
      ) : null}
      {installError ? (
        <div className="game-error">
          <ErrorBanner error={installError} onRetry={() => runtime.navigate({ type: 'install', gameId: game.id })} retryLabel="Abrir progreso" />
        </div>
      ) : null}

      <div className="game-columns">
        <div className="game-main">
          <section className="panel" aria-labelledby="game-metadata-title">
            <div className="panel__head">
              <p className="eyebrow">Ficha local</p>
              <h2 id="game-metadata-title">Metadatos</h2>
              {game.metadata?.isMock ? <span className="demo-badge">Datos de demostración</span> : null}
            </div>
            {game.metadata ? (
              <>
                <dl className="metadata-grid">
                  {game.metadata.releaseYear || game.metadata.releaseDate ? (
                    <div>
                      <dt>Año</dt>
                      <dd>{game.metadata.releaseYear ?? game.metadata.releaseDate}</dd>
                    </div>
                  ) : null}
                  {game.metadata.developers?.length ? (
                    <div>
                      <dt>Desarrollo</dt>
                      <dd>{game.metadata.developers.join(', ')}</dd>
                    </div>
                  ) : null}
                  {game.metadata.publishers?.length ? (
                    <div>
                      <dt>Publicación</dt>
                      <dd>{game.metadata.publishers.join(', ')}</dd>
                    </div>
                  ) : null}
                  {game.metadata.genres?.length ? (
                    <div>
                      <dt>Géneros</dt>
                      <dd>{game.metadata.genres.join(', ')}</dd>
                    </div>
                  ) : null}
                  {game.metadata.gameModes?.length ? (
                    <div>
                      <dt>Modos</dt>
                      <dd>{game.metadata.gameModes.join(', ')}</dd>
                    </div>
                  ) : null}
                  {game.metadata.language ? (
                    <div>
                      <dt>Idioma de datos</dt>
                      <dd>{game.metadata.language}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Proveedor</dt>
                    <dd>
                      {game.metadata.provider} · {game.metadata.providerId}
                    </dd>
                  </div>
                </dl>
                {game.metadata.description ? (
                  <p className="metadata-description">{game.metadata.description}</p>
                ) : null}
              </>
            ) : (
              <div className="metadata-empty">
                <p>No hay metadatos asociados todavía.</p>
                <p className="muted">
                  Puedes buscar una ficha, o continuar solo con los datos del paquete.
                </p>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="game-package-title">
            <div className="panel__head">
              <p className="eyebrow">Paquete</p>
              <h2 id="game-package-title">Instalación</h2>
            </div>
            <dl className="metadata-grid">
              <div>
                <dt>{game.installedVersion && game.installedVersion !== game.currentVersion ? 'Versión instalada' : 'Versión actual'}</dt>
                <dd>v{game.installedVersion ?? game.currentVersion}</dd>
              </div>
              {game.installedVersion && game.installedVersion !== game.currentVersion ? (
                <div>
                  <dt>Paquete actual</dt>
                  <dd>v{game.currentVersion}</dd>
                </div>
              ) : null}
              <div>
                <dt>Perfil de instalador</dt>
                <dd>{INSTALLER_PROFILE_LABELS[game.installerProfile]}</dd>
              </div>
              <div>
                <dt>Elevación</dt>
                <dd>{game.requiresElevation ? 'Requiere UAC' : 'No requiere'}</dd>
              </div>
              <div>
                <dt>Tamaño</dt>
                <dd>{packageSize ?? 'No declarado'}</dd>
              </div>
              <div>
                <dt>Estado</dt>
                <dd>{status.label}</dd>
              </div>
              {install.installDir ? (
                <div className="metadata-grid__wide">
                  <dt>Destino</dt>
                  <dd className="path-text">{install.installDir}</dd>
                </div>
              ) : null}
              {game.availableVersions.length > 0 ? (
                <div className="metadata-grid__wide">
                  <dt>Versiones importadas</dt>
                  <dd>{game.availableVersions.map((entry) => entry.version).join(' · ')}</dd>
                </div>
              ) : null}
            </dl>
            {install.verification ? (
              <p className={`verification ${install.verification.ok ? 'verification--ok' : 'verification--bad'}`}>
                {install.verification.ok
                  ? 'La última comprobación encontró todos los archivos requeridos.'
                  : `Faltan ${install.verification.missingFiles.length} archivos y ${install.verification.missingDirectories.length} carpetas requeridas.`}
              </p>
            ) : null}
            {updated ? <p className="muted small">Actualizado: {updated}</p> : null}
          </section>
        </div>

        <aside className="game-side">
          <section className="panel panel--tight" aria-labelledby="game-identity-title">
            <div className="panel__head">
              <p className="eyebrow">Identidad</p>
              <h2 id="game-identity-title">{identityLabel(game)}</h2>
            </div>
            <p className="identity-summary">
              {game.identity.title ?? game.metadata?.title ?? game.name}
              {game.identity.releaseYear ? ` · ${game.identity.releaseYear}` : ''}
            </p>
            {game.identity.status === 'ambiguous' ? (
              <p className="muted small">
                Hay varios títulos posibles. No se ha asignado ninguno automáticamente.
              </p>
            ) : null}
            {game.identity.message ? <p className="muted small">{game.identity.message}</p> : null}
            {game.identity.candidates.length > 0 ? (
              <p className="muted small">
                {game.identity.candidates.length} candidato
                {game.identity.candidates.length === 1 ? '' : 's'} encontrado
                {game.identity.candidates.length === 1 ? '' : 's'}.
              </p>
            ) : null}
          </section>

          <section className="panel panel--tight" aria-labelledby="game-steam-title">
            <div className="panel__head">
              <p className="eyebrow">Steam</p>
              <h2 id="game-steam-title">{game.steam.enabled ? steamStateLabel(game) : 'No habilitado'}</h2>
            </div>
            <p className="muted small">
              {game.steam.enabled
                ? `Nombre en la biblioteca: ${game.steam.displayName}`
                : 'El manifiesto de este paquete no crea un acceso de Steam.'}
            </p>
            {game.steam.tags.length > 0 ? (
              <p className="micro-tags">
                {game.steam.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </p>
            ) : null}
            {game.steam.syncState === 'pending' ? (
              <p className="muted small">
                Hay cambios pendientes. Se aplicarán al sincronizar desde la pantalla de Steam.
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </section>
  )
}
