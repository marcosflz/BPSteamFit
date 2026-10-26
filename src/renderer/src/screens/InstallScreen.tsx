import { useEffect, useRef } from 'react'
import type { CatalogGame, InstallState } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ErrorBanner } from '../components/ErrorBanner'
import { ProgressBar } from '../components/ProgressBar'
import { StatusChip } from '../components/StatusChip'
import { AlertIcon, FolderIcon, GamepadIcon, PlayIcon, RefreshIcon } from '../components/icons'
import { focusInitialWithin } from '../lib/focus'
import {
  formatBytes,
  formatDateTime,
  formatPercent,
  INSTALL_STATE_LABELS,
  installStateIsActive
} from '../lib/format'
import { fromSerializedError } from '../lib/errors'
import { installStatus } from '../lib/status'

const STATE_DESCRIPTION: Record<InstallState, string> = {
  available: 'Aún no se ha iniciado la instalación.',
  validating: 'Comprobando el paquete, el destino y el espacio disponible.',
  extracting: 'Extrayendo el contenido del paquete a una carpeta temporal.',
  installing: 'El setup del juego se está ejecutando. Puede tardar varios minutos.',
  verifying: 'Comprobando los archivos que el manifiesto requiere.',
  installed: 'La instalación terminó y la verificación fue correcta.',
  reboot_pending: 'El instalador pidió reiniciar Windows para completar la instalación.',
  failed: 'La instalación no terminó correctamente.',
  cancelled: 'La operación se canceló antes de ejecutar el setup.',
  interrupted: 'La app se cerró mientras la instalación estaba en curso.'
}

const STEP_ORDER: InstallState[] = ['validating', 'extracting', 'installing', 'verifying', 'installed']
const STEP_LABELS = ['Validar', 'Extraer', 'Setup', 'Verificar', 'Listo']

function stepIndex(state: InstallState): number {
  const index = STEP_ORDER.indexOf(state)
  if (state === 'reboot_pending') return STEP_ORDER.length - 1
  return index
}

export function InstallScreen(props: { game: CatalogGame }): React.JSX.Element {
  const { game } = props
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, `install:${game.id}`)
  useScreenControls({ onBack: () => runtime.back() })

  const snapshot = game.install
  const status = installStatus(game)
  const progress = snapshot.progress
  const determinate = Boolean(
    progress && progress.indeterminate === false && typeof progress.percent === 'number'
  )
  const percentText = determinate ? formatPercent(progress?.percent) : null
  const doneText = formatBytes(progress?.bytesDone)
  const totalText = formatBytes(progress?.bytesTotal)
  const bytesText = doneText && totalText
    ? `${doneText} de ${totalText}`
    : totalText
      ? `Total: ${totalText}`
      : doneText
        ? `${doneText} procesados`
        : null
  const cancelable = snapshot.state === 'validating' || snapshot.state === 'extracting'
  const operationActive = installStateIsActive(snapshot.state)
  const setupRunning = snapshot.state === 'installing'
  const verifying = snapshot.state === 'verifying'
  const installed = snapshot.state === 'installed'
  const reboot = snapshot.state === 'reboot_pending'
  const failed = ['failed', 'cancelled', 'interrupted'].includes(snapshot.state)
  const canStart = snapshot.state === 'available'
  const installError = fromSerializedError(snapshot.error)
  const currentStep = stepIndex(snapshot.state)
  const showSteps = currentStep >= 0
  const started = formatDateTime(snapshot.startedAt)
  const finished = formatDateTime(snapshot.finishedAt)

  useEffect(() => {
    // Si el control enfocado desaparece al cambiar de fase (por ejemplo, el
    // botón de cancelar al entrar en setup), devolvemos el foco a una acción
    // útil de esta misma pantalla.
    const root = rootRef.current
    if (!root) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) {
      return
    }
    focusInitialWithin(root)
  }, [snapshot.state])

  const toastResult = async (
    result: Awaited<ReturnType<typeof run>>,
    success: string
  ): Promise<void> => {
    if (result.ok) runtime.toast('success', success)
    else runtime.toast('error', result.error.message)
  }

  const launch = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.launchGame(game.id))
      await toastResult(result, `Lanzamiento solicitado: ${game.name}.`)
    })()
  }

  const revalidate = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.revalidateInstall(game.id))
      if (result.ok) {
        runtime.updateGame(result.value)
        const verification = result.value.install.verification
        runtime.toast(
          verification && !verification.ok ? 'error' : 'success',
          verification && !verification.ok
            ? 'Faltan archivos requeridos por el manifiesto.'
            : 'Instalación comprobada.'
        )
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const openFolder = (): void => {
    if (!snapshot.installDir) return
    void (async () => {
      const result = await run(() => runtime.api.openPath(snapshot.installDir as string, 'install-dir'))
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  const openLogs = (): void => {
    void (async () => {
      const result = await run(() =>
        snapshot.logPath
          ? runtime.api.openPath(snapshot.logPath as string, 'log')
          : runtime.api.openLogFolder()
      )
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  const openLogFolder = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.openLogFolder())
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  return (
    <section
      ref={rootRef}
      className="screen install-screen"
      data-screen-root
      aria-labelledby="install-title"
    >
      <div className="install-head">
        <div>
          <p className="eyebrow">Instalación local</p>
          <h1 id="install-title">{game.metadata?.title ?? game.identity.title ?? game.name}</h1>
          <div className="install-head__chips">
            <StatusChip label={INSTALL_STATE_LABELS[snapshot.state]} tone={status.tone} />
            {snapshot.rebootRequired ? <StatusChip label="Reinicio requerido" tone="warn" /> : null}
          </div>
        </div>
        <button
          type="button"
          className="btn btn--quiet"
          data-focusable
          data-focus-id="install-back"
          onClick={() => runtime.back()}
        >
          Volver
        </button>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="install-stage" aria-live="polite">
        <div className="install-stage__state">
          <p className="eyebrow">Estado actual</p>
          <h2>{STATUS_HEADLINES[snapshot.state]}</h2>
          <p className="install-stage__phase">{progress?.phase ?? STATE_DESCRIPTION[snapshot.state]}</p>
        </div>

        {showSteps ? (
          <ol className="install-steps" aria-label="Fases de la instalación">
            {STEP_LABELS.map((label, index) => {
              const completed = index < currentStep || (installed && index === currentStep)
              const active = index === currentStep && !installed
              return (
                <li
                  key={label}
                  className={`install-step ${completed ? 'install-step--done' : ''} ${active ? 'install-step--active' : ''}`}
                >
                  <span className="install-step__dot" aria-hidden="true">
                    {completed ? '✓' : index + 1}
                  </span>
                  <span>{label}</span>
                </li>
              )
            })}
          </ol>
        ) : null}

        {operationActive ? (
          <div className="install-progress">
            {determinate ? (
              <div className="install-progress__number">
                <span data-testid="install-percent">{percentText}</span>
                <small>extracción real</small>
              </div>
            ) : (
              <div className="install-progress__indeterminate">
                <span className="indeterminate-dot" aria-hidden="true" />
                <span>{progress?.indeterminate === false ? 'En curso' : 'Progreso indeterminado'}</span>
              </div>
            )}
            <ProgressBar
              value={determinate ? progress?.percent ?? null : null}
              indeterminate={!determinate}
              label="Progreso de la instalación"
              valueText={determinate ? percentText ?? undefined : progress?.phase}
            />
            {bytesText ? <p className="install-progress__bytes" data-testid="install-bytes">{bytesText}</p> : null}
            {determinate ? null : (
              <p className="install-progress__note">
                El setup no informa de un porcentaje fiable. No se inventan cifras de progreso.
              </p>
            )}
          </div>
        ) : null}

        {snapshot.state === 'validating' ? (
          <p className="inline-note">Puedes cancelar mientras se valida o se extrae el paquete.</p>
        ) : null}
        {setupRunning ? (
          <div className="notice notice--warning" role="status">
            <AlertIcon />
            <div>
              <strong>El setup está en ejecución</strong>
              <p>
                La app no cerrará el proceso por la fuerza durante esta fase. Si el instalador
                necesita intervención, usa su ventana; después vuelve aquí para verificar.
              </p>
            </div>
          </div>
        ) : null}
        {verifying ? (
          <p className="inline-note">
            Los instaladores pueden lanzar procesos secundarios. La comprobación espera los archivos
            requeridos por el manifiesto.
          </p>
        ) : null}
        {reboot ? (
          <div className="notice notice--warning" role="status">
            <AlertIcon />
            <div>
              <strong>Reinicio pendiente</strong>
              <p>
                Reinicia Windows para completar la instalación. Después abre esta pantalla y usa
                «Comprobar instalación» antes de jugar.
              </p>
            </div>
          </div>
        ) : null}

        {installError ? (
          <ErrorBanner
            error={installError}
            onRetry={snapshot.installDir ? revalidate : undefined}
            retryLabel="Comprobar instalación"
          />
        ) : null}

        {snapshot.verification ? (
          <div className={`verification-panel ${snapshot.verification.ok ? 'verification-panel--ok' : 'verification-panel--bad'}`}>
            <div className="verification-panel__head">
              {snapshot.verification.ok ? 'Verificación correcta' : 'Verificación incompleta'}
              <span>{formatDateTime(snapshot.verification.checkedAt)}</span>
            </div>
            {snapshot.verification.missingFiles.length > 0 ? (
              <p>Faltan archivos: {snapshot.verification.missingFiles.join(', ')}</p>
            ) : null}
            {snapshot.verification.missingDirectories.length > 0 ? (
              <p>Faltan carpetas: {snapshot.verification.missingDirectories.join(', ')}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="install-details panel">
        <h2>Detalles de la operación</h2>
        <dl className="metadata-grid">
          <div>
            <dt>Destino</dt>
            <dd className="path-text">{snapshot.installDir ?? 'Sin destino todavía'}</dd>
          </div>
          <div>
            <dt>PID del setup</dt>
            <dd>{snapshot.pid ?? 'No disponible'}</dd>
          </div>
          <div>
            <dt>Código de salida</dt>
            <dd>{snapshot.exitCode ?? 'No disponible'}</dd>
          </div>
          <div>
            <dt>Inicio</dt>
            <dd>{started ?? 'Sin registrar'}</dd>
          </div>
          <div>
            <dt>Fin</dt>
            <dd>{finished ?? 'Aún en curso'}</dd>
          </div>
          <div className="metadata-grid__wide">
            <dt>Log</dt>
            <dd className="path-text">{snapshot.logPath ?? 'La app no registró una ruta de log.'}</dd>
          </div>
        </dl>
      </div>

      <div className="install-actions">
        {cancelable ? (
          <button
            type="button"
            className="btn btn--danger btn--large"
            data-focusable
            data-focus-id="install-cancel"
            data-autofocus
            onClick={() => runtime.openDialog({ kind: 'cancel-install', gameId: game.id })}
          >
            Cancelar instalación
          </button>
        ) : null}
        {canStart || failed ? (
          <button
            type="button"
            className={`btn btn--primary btn--large ${cancelable ? '' : 'is-initial'}`}
            data-focusable
            data-focus-id="install-retry"
            data-autofocus={!cancelable ? true : undefined}
            onClick={() => runtime.openDialog({ kind: 'install', gameId: game.id })}
            disabled={busy || !game.packageAvailable}
          >
            {failed ? 'Reintentar instalación' : 'Iniciar instalación'}
          </button>
        ) : null}
        {installed ? (
          <button
            type="button"
            className="btn btn--primary btn--large"
            data-focusable
            data-focus-id="install-play"
            data-autofocus
            onClick={launch}
            disabled={busy}
          >
            <PlayIcon /> Jugar
          </button>
        ) : null}
        {snapshot.installDir ? (
          <button
            type="button"
            className="btn btn--large"
            data-focusable
            data-focus-id="install-folder"
            onClick={openFolder}
            disabled={busy}
          >
            <FolderIcon width={18} height={18} /> Abrir carpeta
          </button>
        ) : null}
        {snapshot.installDir && !operationActive ? (
          <button
            type="button"
            className="btn btn--large"
            data-focusable
            data-focus-id="install-verify"
            data-autofocus={reboot ? true : undefined}
            onClick={revalidate}
            disabled={busy}
          >
            <RefreshIcon width={18} height={18} /> Comprobar instalación
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--large"
          data-focusable
          data-focus-id="install-logs"
          onClick={openLogs}
          disabled={busy}
        >
          Abrir log
        </button>
        <button
          type="button"
          className="btn btn--large btn--quiet"
          data-focusable
          data-focus-id="install-log-folder"
          onClick={openLogFolder}
          disabled={busy}
        >
          Carpeta de logs
        </button>
        {!cancelable && !canStart && !failed && !installed ? (
          <p className="install-actions__hint">
            {setupRunning
              ? 'Durante el setup no se fuerza el cierre del instalador.'
              : activeCopy(snapshot.state)}
          </p>
        ) : null}
      </div>

      {!snapshot.logPath ? (
        <p className="muted small">
          Este estado no incluye una ruta de log. La app abrirá la carpeta general de logs si está
          disponible.
        </p>
      ) : null}

      <div className="install-footer-note">
        <GamepadIcon width={18} height={18} />
        <span>Puedes salir de esta pantalla y volver; la operación continúa en segundo plano.</span>
      </div>
    </section>
  )
}

const STATUS_HEADLINES: Record<InstallState, string> = {
  available: 'Lista para empezar',
  validating: 'Validando el paquete',
  extracting: 'Extrayendo archivos',
  installing: 'Setup en ejecución',
  verifying: 'Verificando la instalación',
  installed: 'Instalación completada',
  reboot_pending: 'Reinicio necesario',
  failed: 'La instalación falló',
  cancelled: 'Instalación cancelada',
  interrupted: 'Instalación interrumpida'
}

function activeCopy(state: InstallState): string {
  if (installStateIsActive(state)) return 'La operación continúa en segundo plano.'
  return STATE_DESCRIPTION[state]
}
