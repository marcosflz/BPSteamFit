import { useCallback, useEffect, useRef, useState } from 'react'
import type { SteamAccount, SteamPendingChange, SteamStatus, SteamSyncStatus } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusChip } from '../components/StatusChip'
import { AlertIcon, FolderIcon, RefreshIcon } from '../components/icons'
import { formatDateTime } from '../lib/format'
import { fromSerializedError, toUiError, type UiError } from '../lib/errors'

function changeActionLabel(change: SteamPendingChange): string {
  return change.action === 'add' ? 'Añadir acceso' : 'Actualizar acceso'
}

const SYNC_RESULT_LABELS: Record<SteamSyncStatus, string> = {
  idle: 'Sin iniciar',
  pending: 'Pendiente',
  running: 'En curso',
  completed: 'Completada',
  failed: 'Fallida',
  aborted: 'Abortada'
}

function syncStatusLabel(steam: SteamStatus): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' } {
  if (!steam.installed) return { label: 'Steam no encontrado', tone: 'danger' }
  if (steam.accounts.length === 0) return { label: 'Sin perfiles de Steam', tone: 'warn' }
  if (steam.lastResult?.status === 'running') return { label: 'Sincronización en curso', tone: 'info' }
  if (steam.lastResult?.status === 'pending') return { label: 'Sincronización pendiente', tone: 'info' }
  if (steam.pendingChanges.length > 0) return { label: 'Cambios pendientes', tone: 'warn' }
  if (steam.lastResult?.status === 'completed') return { label: 'Sincronización completada', tone: 'ok' }
  if (steam.lastResult?.status === 'failed') return { label: 'Sincronización fallida', tone: 'danger' }
  if (steam.lastResult?.status === 'aborted') return { label: 'Sincronización abortada', tone: 'warn' }
  return { label: 'Sin cambios pendientes', tone: 'muted' }
}

export function SteamScreen(): React.JSX.Element {
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loadError, setLoadError] = useState<UiError | null>(null)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, 'steam', { ready: hasLoaded })
  useScreenControls({ onBack: () => runtime.back() })

  const steam = runtime.steam

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const status = await runtime.api.getSteamStatus()
      runtime.updateSteam(status)
    } catch (caught) {
      setLoadError(toUiError(caught))
    } finally {
      setLoading(false)
      setHasLoaded(true)
    }
  }, [runtime.api, runtime.updateSteam])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = (): void => {
    void (async () => {
      const result = await run(load)
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  const selectAccount = (account: SteamAccount): void => {
    void (async () => {
      const result = await run(() => runtime.api.selectSteamAccount(account.accountId))
      if (result.ok) {
        runtime.updateSteam(result.value)
        runtime.toast(
          'success',
          `Perfil seleccionado: ${account.personaName ?? account.steamId64 ?? account.accountId}.`
        )
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const prepareSync = (): void => {
    runtime.openDialog({ kind: 'steam-sync' })
  }

  const openLogs = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.openLogFolder())
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  const lastError = fromSerializedError(steam.lastResult?.error)
  const status = syncStatusLabel(steam)
  const selectedAccountId = steam.selectedAccountId
  const syncInProgress =
    steam.lastResult?.status === 'running' || steam.lastResult?.status === 'pending'
  const canSync =
    steam.installed &&
    steam.accounts.length > 0 &&
    steam.pendingChanges.length > 0 &&
    !syncInProgress

  return (
    <section ref={rootRef} className="screen steam-screen" data-screen-root aria-labelledby="steam-title">
      <div className="screen-head">
        <div>
          <p className="eyebrow">Biblioteca de Steam</p>
          <h1 id="steam-title">Steam</h1>
          <p className="screen-head__description">
            Perfiles, cambios pendientes y el resultado real de la última sincronización. BPSteamFit
            solo escribe el acceso directo en la biblioteca; no descripciones ni datos de tienda.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="steam-refresh"
            data-autofocus={!canSync ? true : undefined}
            onClick={refresh}
            disabled={busy || loading}
          >
            <RefreshIcon width={18} height={18} /> Actualizar estado
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            data-focusable
            data-focus-id="steam-back"
            onClick={() => runtime.back()}
          >
            Volver
          </button>
        </div>
      </div>

      {loadError ? <ErrorBanner error={loadError} onRetry={refresh} /> : null}
      {error ? <ErrorBanner error={error} /> : null}

      {loading && !hasLoaded ? (
        <div className="steam-loading" role="status">
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line skeleton--short" />
        </div>
      ) : (
        <>
          <div className="steam-overview panel">
            <div className="steam-overview__main">
              <p className="eyebrow">Estado</p>
              <div className="steam-overview__title">
                <StatusChip label={status.label} tone={status.tone} />
                {steam.running ? <StatusChip label="Steam en ejecución" tone="warn" /> : null}
                {!steam.installed ? <StatusChip label="No instalado" tone="danger" /> : null}
              </div>
              <p className="muted">
                {steam.installed
                  ? 'La sincronización modifica la biblioteca de accesos directos del perfil seleccionado.'
                  : 'No se encontró una instalación de Steam. Puedes seguir usando la biblioteca local.'}
              </p>
              {steam.steamPath ? <p className="path-text">{steam.steamPath}</p> : null}
              {steam.warning ? (
                <div className="notice notice--warning">
                  <AlertIcon />
                  <p>{steam.warning}</p>
                </div>
              ) : null}
            </div>
            <div className="steam-overview__actions">
              <button
                type="button"
                className="btn btn--primary btn--large"
                data-focusable
                data-focus-id="steam-sync"
                data-autofocus={canSync ? true : undefined}
                onClick={prepareSync}
                disabled={busy || loading || !canSync}
              >
                Sincronizar con Steam
              </button>
              <p className="muted small">
                {syncInProgress
                  ? 'Hay una sincronización en curso o pendiente. Espera a que termine o vuelve a abrir la app para ver el resultado.'
                  : steam.pendingChanges.length === 0
                    ? 'No hay cambios pendientes. Instala o actualiza un juego para preparar accesos.'
                    : 'Se pedirá confirmación. BPSteamFit se cerrará para aplicar los cambios; Steam se cerrará de forma normal y se reabrirá en Big Picture. Si no se cierra, no se modifica nada. Verás el resultado al volver a abrir la app.'}
              </p>
            </div>
          </div>

          {steam.running ? (
            <div className="notice notice--warning" role="status">
              <AlertIcon />
              <div>
                <strong>Steam está abierto</strong>
                <p>
                  Al confirmar, la app se cerrará y pedirá a Steam un cierre ordenado para escribir
                  la biblioteca. Si Steam no se cierra, la operación se abortará sin forzar procesos.
                </p>
              </div>
            </div>
          ) : null}

          <div className="steam-columns">
            <section className="panel" aria-labelledby="steam-accounts-title">
              <div className="panel__head">
                <p className="eyebrow">Cuentas</p>
                <h2 id="steam-accounts-title">Perfiles detectados</h2>
              </div>
              {steam.accounts.length === 0 ? (
                <p className="muted">
                  No se encontraron perfiles. Inicia sesión en Steam al menos una vez y actualiza el
                  estado.
                </p>
              ) : (
                <div className="account-list">
                  {steam.accounts.map((account) => {
                    const selected = account.accountId === selectedAccountId || account.isSelected
                    const name = account.personaName ?? account.steamId64 ?? account.accountId
                    return (
                      <button
                        key={account.accountId}
                        type="button"
                        className={`account-card ${selected ? 'account-card--selected' : ''}`}
                        data-focusable
                        data-focus-id={`steam-account-${account.accountId}`}
                        aria-pressed={selected}
                        aria-label={`${name}${selected ? ', perfil seleccionado' : ''}`}
                        onClick={() => selectAccount(account)}
                        disabled={busy || loading}
                      >
                        <span className="account-card__avatar" aria-hidden="true">
                          {name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="account-card__copy">
                          <span className="account-card__name">{name}</span>
                          <span className="muted small">{account.steamId64 ?? account.accountId}</span>
                          <span className="path-text small">{account.shortcutsPath}</span>
                        </span>
                        <span className="account-card__badges">
                          {selected ? <span className="chosen-badge">Seleccionado</span> : null}
                          {account.isActive ? <span className="verified-badge">Activo en Steam</span> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="steam-pending-title">
              <div className="panel__head">
                <p className="eyebrow">Cola</p>
                <h2 id="steam-pending-title">
                  {steam.pendingChanges.length} cambio{steam.pendingChanges.length === 1 ? '' : 's'} pendiente
                  {steam.pendingChanges.length === 1 ? '' : 's'}
                </h2>
              </div>
              {steam.pendingChanges.length === 0 ? (
                <p className="muted">
                  No hay accesos pendientes. Los cambios aparecen al instalar o actualizar un juego.
                </p>
              ) : (
                <ul className="pending-list">
                  {steam.pendingChanges.map((change) => (
                    <li key={`${change.gameId}-${change.action}`}>
                      <div>
                        <strong>{change.gameName}</strong>
                        <p className="muted small">
                          {changeActionLabel(change)}
                          {change.shortcutAppId ? ` · AppID ${change.shortcutAppId}` : ''}
                        </p>
                        <p className="small">{change.reason}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted small">
                Se actualizará el nombre y el ejecutable del acceso. La descripción de la ficha no se
                escribe en Steam.
              </p>
            </section>
          </div>

          <section className="panel" aria-labelledby="steam-result-title">
            <div className="panel__head">
              <p className="eyebrow">Último resultado</p>
              <h2 id="steam-result-title">Sincronización</h2>
            </div>
            {steam.lastResult ? (
              <dl className="sync-result">
                <div>
                  <dt>Estado</dt>
                  <dd>
                    {SYNC_RESULT_LABELS[steam.lastResult.status]}
                    {steam.lastResult.steamRestarted ? ' · Steam reiniciado' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Solicitada</dt>
                  <dd>{formatDateTime(steam.lastResult.requestedAt) ?? steam.lastResult.requestedAt}</dd>
                </div>
                <div>
                  <dt>Completada</dt>
                  <dd>{formatDateTime(steam.lastResult.completedAt) ?? 'Sin completar'}</dd>
                </div>
                <div>
                  <dt>Juegos aplicados</dt>
                  <dd>
                    {steam.lastResult.appliedGameIds.length === 0
                      ? 'Ninguno'
                      : steam.lastResult.appliedGameIds
                          .map((gameId) => runtime.games.find((game) => game.id === gameId)?.name ?? gameId)
                          .join(', ')}
                  </dd>
                </div>
                {steam.lastResult.backupPath ? (
                  <div className="metadata-grid__wide">
                    <dt>Backup</dt>
                    <dd className="path-text">{steam.lastResult.backupPath}</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="muted">Todavía no se ha iniciado una sincronización.</p>
            )}
            {lastError ? <ErrorBanner error={lastError} /> : null}
            <div className="action-row">
              <button
                type="button"
                className="btn"
                data-focusable
                data-focus-id="steam-logs"
                onClick={openLogs}
                disabled={busy}
              >
                <FolderIcon width={18} height={18} /> Abrir carpeta de logs
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  )
}
