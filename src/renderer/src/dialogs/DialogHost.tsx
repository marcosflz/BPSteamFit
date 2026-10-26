import { useState, type FormEvent, type ReactNode } from 'react'
import { useRuntime } from '../runtime/AppRuntime'
import type { AppDialog } from '../navigation/dialogs'
import { Modal } from '../components/Modal'
import { ErrorBanner } from '../components/ErrorBanner'
import { toUiError, type UiError } from '../lib/errors'
import { formatBytes } from '../lib/format'

function DialogActions(props: {
  busy: boolean
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  cancelLabel?: string
  tone?: 'primary' | 'danger'
}): React.JSX.Element {
  return (
    <div className="modal__actions">
      <button
        type="button"
        className="btn"
        data-focusable
        data-focus-id="dialog-cancel"
        data-autofocus
        onClick={props.onCancel}
        disabled={props.busy}
      >
        {props.cancelLabel ?? 'Cancelar'}
      </button>
      <button
        type="button"
        className={`btn ${props.tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
        data-focusable
        data-focus-id="dialog-confirm"
        onClick={props.onConfirm}
        disabled={props.busy}
      >
        {props.busy ? 'Procesando…' : props.confirmLabel}
      </button>
    </div>
  )
}

function MissingDialog(): React.JSX.Element {
  const runtime = useRuntime()
  return (
    <Modal title="Juego no disponible" onClose={runtime.closeDialog}>
      <p>El juego ya no está en el catálogo. Vuelve a la biblioteca y actualiza.</p>
      <div className="modal__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-focusable
          data-autofocus
          onClick={runtime.closeDialog}
        >
          Cerrar
        </button>
      </div>
    </Modal>
  )
}

function ConfirmDialog(props: {
  title: string
  eyebrow: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => Promise<void>
  onCancel: () => void
  tone?: 'primary' | 'danger'
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={props.title} eyebrow={props.eyebrow} onClose={props.onCancel}>
      {props.children}
      {error ? <ErrorBanner error={error} /> : null}
      <DialogActions
        busy={busy}
        confirmLabel={props.confirmLabel}
        tone={props.tone}
        onCancel={props.onCancel}
        onConfirm={() => void run()}
      />
    </Modal>
  )
}

function InstallDialog(props: { gameId: string }): React.JSX.Element {
  const runtime = useRuntime()
  const game = runtime.games.find((entry) => entry.id === props.gameId)
  const [chosenDir, setChosenDir] = useState<string | null>(game?.install.installDir ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  if (!game) return <MissingDialog />

  const packageSize = formatBytes(game.packageSize)

  const chooseFolder = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const folder = await runtime.api.chooseInstallFolder(game.id)
      if (folder) setChosenDir(folder)
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!game.packageAvailable) {
      setError(
        toUiError({
          code: 'PACKAGE_UNAVAILABLE',
          message: 'El paquete ya no está disponible. Actualiza el catálogo antes de instalar.'
        })
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await runtime.api.startInstall({
        gameId: game.id,
        installDir: chosenDir ?? undefined
      })
      runtime.updateGame({ ...game, install: result.snapshot })
      runtime.closeDialog()
      runtime.navigate({ type: 'install', gameId: game.id })
      runtime.toast('success', 'Instalación iniciada.')
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Instalar ${game.metadata?.title ?? game.name}`} eyebrow="Confirmación" onClose={runtime.closeDialog}>
      <div className="dialog-summary">
        <div>
          <span className="eyebrow">Versión</span>
          <p>v{game.currentVersion}</p>
        </div>
        <div>
          <span className="eyebrow">Paquete</span>
          <p>{packageSize ?? 'Tamaño no declarado'}</p>
        </div>
        <div>
          <span className="eyebrow">Instalador</span>
          <p>{game.installerProfile}</p>
        </div>
      </div>
      <div className="dialog-destination">
        <p className="eyebrow">Destino</p>
        {chosenDir ? (
          <p className="path-text">{chosenDir}</p>
        ) : (
          <p>
            Se creará una carpeta para el juego dentro de la raíz configurada:
            <span className="path-text">
              {' '}
              {`${runtime.settings.installationRoot.replace(/[\\/]+$/, '')}\\${game.id}`}
            </span>
          </p>
        )}
        <button
          type="button"
          className="btn btn--small"
          data-focusable
          onClick={() => void chooseFolder()}
          disabled={busy}
        >
          Elegir otra carpeta…
        </button>
        <p className="muted small">
          El selector de carpetas es una ventana del sistema. Si el mando no responde allí, usa el
          teclado o el ratón.
        </p>
      </div>
      {game.requiresElevation ? (
        <div className="notice notice--warning">
          <div>
            <strong>Requiere elevación</strong>
            <p>
              Se usará un auxiliar que eleva solo el setup. Windows mostrará UAC en el escritorio
              seguro y el mando no puede controlarlo: necesitarás teclado o ratón. Si cancelas UAC,
              no se modificará nada.
            </p>
          </div>
        </div>
      ) : null}
      {!game.packageAvailable ? (
        <p className="inline-note">El paquete no está disponible. Actualiza el catálogo antes de instalar.</p>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}
      <DialogActions
        busy={busy}
        confirmLabel="Instalar ahora"
        onCancel={runtime.closeDialog}
        onConfirm={() => void confirm()}
      />
    </Modal>
  )
}

function CancelInstallDialog(props: { gameId: string }): React.JSX.Element {
  const runtime = useRuntime()
  const game = runtime.games.find((entry) => entry.id === props.gameId)
  if (!game) return <MissingDialog />

  return (
    <ConfirmDialog
      title="Cancelar instalación"
      eyebrow="Operación en curso"
      confirmLabel="Sí, cancelar"
      tone="danger"
      onCancel={runtime.closeDialog}
      onConfirm={async () => {
        await runtime.api.cancelOperation(game.id)
        runtime.closeDialog()
        runtime.toast('info', 'Cancelación solicitada. El estado se actualizará al recibir el evento.')
      }}
    >
      <p>
        Se detendrá la validación o la extracción de <strong>{game.name}</strong>. Solo es posible
        antes de que arranque el setup; después, la app no fuerza el cierre del instalador.
      </p>
    </ConfirmDialog>
  )
}

function ClearIdentityDialog(props: { gameId: string }): React.JSX.Element {
  const runtime = useRuntime()
  const game = runtime.games.find((entry) => entry.id === props.gameId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)
  if (!game) return <MissingDialog />

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await runtime.api.clearIdentity(game.id)
      runtime.updateGame(updated)
      runtime.closeDialog()
      runtime.toast('success', 'Identidad y metadatos eliminados. Se usará el nombre del paquete.')
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Quitar identidad y metadatos" eyebrow="Metadatos" onClose={runtime.closeDialog}>
      <p>
        <strong>{game.metadata?.title ?? game.name}</strong> volverá a mostrarse con los datos del
        paquete. Podrás buscar otra ficha cuando quieras.
      </p>
      {error ? <ErrorBanner error={error} /> : null}
      <DialogActions
        busy={busy}
        confirmLabel="Quitar metadatos"
        tone="danger"
        onCancel={runtime.closeDialog}
        onConfirm={() => void confirm()}
      />
    </Modal>
  )
}

function SteamSyncDialog(): React.JSX.Element {
  const runtime = useRuntime()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)
  const pending = runtime.steam.pendingChanges.length

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const prepared = await runtime.api.prepareSteamSync()
      runtime.updateSteam(prepared)
      const result = await runtime.api.startSteamSync(true)
      if (!result.scheduled) {
        try {
          const status = await runtime.api.getSteamStatus()
          runtime.updateSteam(status)
        } catch {
          // El resultado se puede refrescar a mano desde la pantalla de Steam.
        }
        runtime.closeDialog()
        runtime.toast('info', result.message)
        return
      }
      runtime.closeDialog()
      runtime.toast('success', result.message)
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Sincronizar con Steam" eyebrow="Confirmación" onClose={runtime.closeDialog}>
      <div className="notice notice--warning">
        <div>
          <strong>BPSteamFit se cerrará y Steam se reiniciará</strong>
          <p>
            La app se cerrará para que el auxiliar escriba la biblioteca. Steam se cerrará de forma
            normal y se reabrirá en Big Picture. Si Steam no se cierra en 30 segundos, la
            sincronización se aborta sin modificar archivos. El resultado aparecerá al volver a
            abrir BPSteamFit.
          </p>
        </div>
      </div>
      <p>
        Se aplicarán <strong>{pending}</strong> cambio{pending === 1 ? '' : 's'} pendiente
        {pending === 1 ? '' : 's'} en el perfil seleccionado. Solo se actualizan los accesos
        directos; no se escriben descripciones ni datos de tienda. El backup de la biblioteca se
        intenta antes de escribir y su ruta aparece en el último resultado.
      </p>
      {runtime.steam.running ? (
        <p className="inline-note">
          Steam está abierto ahora mismo. Si no se cierra de forma ordenada, la sincronización se
          abortará.
        </p>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}
      <DialogActions
        busy={busy}
        confirmLabel="Sincronizar ahora"
        onCancel={runtime.closeDialog}
        onConfirm={() => void confirm()}
      />
    </Modal>
  )
}

function SteamKeyDialog(): React.JSX.Element {
  const runtime = useRuntime()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) {
      setError(toUiError({ message: 'Introduce una clave antes de guardar.' }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const providers = await runtime.api.setSteamGridDbKey(trimmed)
      setKey('')
      runtime.updateProviders(providers)
      runtime.closeDialog()
      runtime.toast('success', 'Clave de SteamGridDB guardada.')
    } catch (caught) {
      setError(toUiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Clave de SteamGridDB" eyebrow="Credencial" onClose={runtime.closeDialog}>
      <form className="key-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="sgdb-key">Clave de API</label>
        <input
          id="sgdb-key"
          className="text-input"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-focusable
          data-autofocus
          aria-describedby="sgdb-key-help"
        />
        <p id="sgdb-key-help" className="muted small">
          El campo requiere teclado físico y no se muestra en claro. La clave se envía directamente
          al proceso principal; la interfaz no la registra ni la conserva después de guardar.
        </p>
        {error ? <ErrorBanner error={error} /> : null}
        <div className="modal__actions">
          <button
            type="button"
            className="btn"
            data-focusable
            onClick={runtime.closeDialog}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            data-focusable
            disabled={busy || !key.trim()}
          >
            {busy ? 'Guardando…' : 'Guardar clave'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ClearSteamKeyDialog(): React.JSX.Element {
  const runtime = useRuntime()
  return (
    <ConfirmDialog
      title="Borrar clave de SteamGridDB"
      eyebrow="Credencial"
      confirmLabel="Borrar clave"
      tone="danger"
      onCancel={runtime.closeDialog}
      onConfirm={async () => {
        const providers = await runtime.api.clearSteamGridDbKey()
        runtime.updateProviders(providers)
        runtime.closeDialog()
        runtime.toast('success', 'Clave de SteamGridDB borrada.')
      }}
    >
      <p>
        SteamGridDB dejará de estar disponible hasta que configures otra clave. Las imágenes locales
        y la selección actual del catálogo no se tocan desde este diálogo.
      </p>
    </ConfirmDialog>
  )
}

function QuitDialog(): React.JSX.Element {
  const runtime = useRuntime()
  return (
    <ConfirmDialog
      title="Salir de BPSteamFit"
      eyebrow="Aplicación"
      confirmLabel="Sí, salir"
      tone="danger"
      onCancel={runtime.closeDialog}
      onConfirm={async () => {
        await runtime.api.quit()
        runtime.closeDialog()
      }}
    >
      <p>
        Si hay una instalación en curso, salir de la app la dejará interrumpida. El motor no fuerza
        el cierre del setup desde esta ventana.
      </p>
    </ConfirmDialog>
  )
}

export function DialogHost(props: { dialog: AppDialog }): React.JSX.Element {
  switch (props.dialog.kind) {
    case 'install':
      return <InstallDialog gameId={props.dialog.gameId} />
    case 'cancel-install':
      return <CancelInstallDialog gameId={props.dialog.gameId} />
    case 'clear-identity':
      return <ClearIdentityDialog gameId={props.dialog.gameId} />
    case 'steam-sync':
      return <SteamSyncDialog />
    case 'steam-key':
      return <SteamKeyDialog />
    case 'clear-steam-key':
      return <ClearSteamKeyDialog />
    case 'quit':
      return <QuitDialog />
  }
}
