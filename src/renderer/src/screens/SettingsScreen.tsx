import { useRef } from 'react'
import type { SettingsPatch } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusChip } from '../components/StatusChip'
import { FolderIcon, KeyboardIcon, RefreshIcon } from '../components/icons'

export function SettingsScreen(): React.JSX.Element {
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, 'settings')
  useScreenControls({ onBack: () => runtime.back() })

  const settings = runtime.settings
  const providers = runtime.providers

  const applySettings = (patch: SettingsPatch, success: string): void => {
    void (async () => {
      const result = await run(() => runtime.api.updateSettings(patch))
      if (result.ok) {
        runtime.updateSettings(result.value)
        if (patch.metadataProvider) {
          void runtime.api
            .getProviderStatus()
            .then((providers) => runtime.updateProviders(providers))
            .catch(() => undefined)
        }
        runtime.toast('success', success)
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const addPackageFolder = (): void => {
    void (async () => {
      const result = await run(async () => {
        const next = await runtime.api.addPackageFolder()
        if (!next) return false
        runtime.updateSettings(next)
        await runtime.rescanPackages()
        return true
      })
      if (!result.ok) runtime.toast('error', result.error.message)
      else if (result.value) runtime.toast('success', 'Carpeta de paquetes añadida.')
    })()
  }

  const chooseInstallRoot = (): void => {
    void (async () => {
      const result = await run(async () => {
        const next = await runtime.api.chooseInstallationRoot()
        if (!next) return false
        runtime.updateSettings(next)
        return true
      })
      if (!result.ok) runtime.toast('error', result.error.message)
      else if (result.value) runtime.toast('success', 'Raíz de instalación actualizada.')
    })()
  }

  const refreshProviders = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.getProviderStatus())
      if (result.ok) {
        runtime.updateProviders(result.value)
        runtime.toast('success', 'Estado de proveedores actualizado.')
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const openLogs = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.openLogFolder())
      if (!result.ok) runtime.toast('error', result.error.message)
    })()
  }

  return (
    <section
      ref={rootRef}
      className="screen settings-screen"
      data-screen-root
      aria-labelledby="settings-title"
    >
      <div className="screen-head">
        <div>
          <p className="eyebrow">Configuración</p>
          <h1 id="settings-title">Ajustes</h1>
          <p className="screen-head__description">
            Carpetas, metadatos, Steam y controles. Los cambios se guardan al confirmar cada acción.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--quiet"
          data-focusable
          data-focus-id="settings-back"
          onClick={() => runtime.back()}
        >
          Volver
        </button>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <section className="settings-section panel" aria-labelledby="settings-packages">
        <div className="panel__head">
          <p className="eyebrow">Biblioteca</p>
          <h2 id="settings-packages">Carpetas de paquetes</h2>
          <button
            type="button"
            className="btn btn--small"
            data-focusable
            data-focus-id="settings-add-folder"
            data-autofocus
            onClick={addPackageFolder}
            disabled={busy}
          >
            <FolderIcon width={16} height={16} /> Añadir carpeta
          </button>
        </div>
        <p className="muted small">
          La app busca archivos <strong>.game</strong> en estas carpetas. No se mueve nada de sitio.
          Los selectores de carpetas son ventanas del sistema; si el mando no responde allí, usa el
          teclado o el ratón.
        </p>
        {settings.packageFolders.length === 0 ? (
          <p className="muted">No hay carpetas configuradas.</p>
        ) : (
          <ul className="path-list">
            {settings.packageFolders.map((folder) => (
              <li key={folder}>
                <span className="path-text">{folder}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-section panel" aria-labelledby="settings-root">
        <div className="panel__head">
          <p className="eyebrow">Instalación</p>
          <h2 id="settings-root">Raíz de instalación</h2>
        </div>
        <div className="setting-row">
          <div>
            <p className="path-text">{settings.installationRoot}</p>
            <p className="muted small">
              Cada juego se instala en una subcarpeta dentro de esta raíz salvo que elijas otro
              destino al instalar.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="settings-install-root"
            onClick={chooseInstallRoot}
            disabled={busy}
          >
            Elegir raíz
          </button>
        </div>
      </section>

      <section className="settings-section panel" aria-labelledby="settings-metadata">
        <div className="panel__head">
          <p className="eyebrow">Metadatos</p>
          <h2 id="settings-metadata">Proveedor</h2>
          <button
            type="button"
            className="btn btn--small btn--quiet"
            data-focusable
            onClick={refreshProviders}
            disabled={busy}
            aria-label="Actualizar estado de proveedores"
          >
            <RefreshIcon width={16} height={16} />
          </button>
        </div>
        <div className="provider-choices" role="group" aria-label="Proveedor de metadatos">
          <button
            type="button"
            className={`provider-card ${settings.metadataProvider === 'mock' ? 'provider-card--active' : ''}`}
            data-focusable
            data-focus-id="settings-provider-mock"
            aria-pressed={settings.metadataProvider === 'mock'}
            onClick={() => applySettings({ metadataProvider: 'mock' }, 'Proveedor local activado.')}
            disabled={busy}
          >
            <strong>Catálogo local</strong>
            <span className="muted small">{providers.mock.description}</span>
            <StatusChip label="Disponible" tone="ok" />
          </button>
          <button
            type="button"
            className={`provider-card ${settings.metadataProvider === 'steamgriddb' ? 'provider-card--active' : ''}`}
            data-focusable
            data-focus-id="settings-provider-sgdb"
            aria-pressed={settings.metadataProvider === 'steamgriddb'}
            onClick={() =>
              applySettings(
                { metadataProvider: 'steamgriddb' },
                'Proveedor SteamGridDB activado.'
              )
            }
            disabled={busy || !providers.steamgriddb.configured}
          >
            <strong>SteamGridDB</strong>
            <span className="muted small">{providers.steamgriddb.description}</span>
            <StatusChip
              label={
                providers.steamgriddb.configured
                  ? settings.metadataProvider === 'steamgriddb'
                    ? providers.steamgriddb.available
                      ? 'Disponible'
                      : 'Sin conexión'
                    : 'Configurado'
                  : 'Sin clave'
              }
              tone={
                providers.steamgriddb.configured
                  ? settings.metadataProvider === 'steamgriddb' && !providers.steamgriddb.available
                    ? 'warn'
                    : 'ok'
                  : 'muted'
              }
            />
          </button>
        </div>
        {!providers.steamgriddb.configured ? (
          <p className="inline-note">
            SteamGridDB necesita una clave propia. Sin ella, el proveedor local sigue disponible.
          </p>
        ) : (
          <p className="muted small">{providers.steamgriddb.attribution}</p>
        )}
        <div className="setting-row">
          <div>
            <strong>Fichas en español</strong>
            <p className="muted small">
              Pide al proveedor los campos de texto en español cuando estén disponibles. No cambia
              el idioma del juego.
            </p>
          </div>
          <button
            type="button"
            className={`toggle ${settings.referToMetadataInSpanish ? 'toggle--on' : ''}`}
            data-focusable
            aria-pressed={settings.referToMetadataInSpanish}
            aria-label={`Fichas en español: ${settings.referToMetadataInSpanish ? 'activado' : 'desactivado'}`}
            onClick={() =>
              applySettings(
                { referToMetadataInSpanish: !settings.referToMetadataInSpanish },
                settings.referToMetadataInSpanish
                  ? 'Preferencia de idioma: sin filtro.'
                  : 'Preferencia de idioma: español.'
              )
            }
            disabled={busy}
          >
            <span className="toggle__track" aria-hidden="true">
              <span className="toggle__thumb" />
            </span>
            {settings.referToMetadataInSpanish ? 'Sí' : 'No'}
          </button>
        </div>
      </section>

      <section className="settings-section panel" aria-labelledby="settings-key">
        <div className="panel__head">
          <p className="eyebrow">Credenciales</p>
          <h2 id="settings-key">Clave de SteamGridDB</h2>
          <StatusChip
            label={providers.steamgriddb.configured ? 'Clave configurada' : 'Sin clave'}
            tone={providers.steamgriddb.configured ? 'ok' : 'muted'}
          />
        </div>
        <div className="setting-row">
          <div>
            <p>
              La clave se envía al proceso principal y nunca se muestra en claro ni se registra en
              la interfaz.
            </p>
            <p className="keyboard-only">
              <KeyboardIcon width={18} height={18} />
              Configurar la clave requiere teclado físico. El mando puede navegar al diálogo, pero el
              campo no admite el teclado en pantalla.
            </p>
          </div>
          <div className="action-row">
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="settings-key-configure"
              onClick={() => runtime.openDialog({ kind: 'steam-key' })}
              disabled={busy}
            >
              {providers.steamgriddb.configured ? 'Cambiar clave' : 'Configurar clave'}
            </button>
            {providers.steamgriddb.configured ? (
              <button
                type="button"
                className="btn btn--danger"
                data-focusable
                data-focus-id="settings-key-clear"
                onClick={() => runtime.openDialog({ kind: 'clear-steam-key' })}
                disabled={busy}
              >
                Borrar clave
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="settings-section panel" aria-labelledby="settings-controls">
        <div className="panel__head">
          <p className="eyebrow">Controles</p>
          <h2 id="settings-controls">Mando y teclado</h2>
        </div>
        <div className="controller-help">
          <div>
            <h3>Mapa del mando</h3>
            <dl className="control-map">
              <div><dt>A</dt><dd>Aceptar / elegir</dd></div>
              <div><dt>B</dt><dd>Volver / salir del campo</dd></div>
              <div><dt>X</dt><dd>Acción opcional de la pantalla</dd></div>
              <div><dt>Y</dt><dd>Acción secundaria opcional</dd></div>
              <div><dt>LB / RB</dt><dd>Cambiar pestaña o filtro</dd></div>
              <div><dt>Start</dt><dd>Abrir ajustes / volver</dd></div>
              <div><dt>Back</dt><dd>Volver</dd></div>
              <div><dt>Cruceta / stick</dt><dd>Mover el foco</dd></div>
            </dl>
          </div>
          <div>
            <h3>Steam Input</h3>
            <p className="muted small">
              BPSteamFit lee la Gamepad API estándar. Si Steam Input está configurado como capa
              global o el mando usa un perfil de escritorio que emula teclado y ratón, los botones
              pueden llegar remapeados o no llegar. Para probar, desactiva temporalmente la capa de
              Steam Input o usa un perfil de mando estándar.
            </p>
            <p className="muted small">
              Reconexión: si el mando se desconecta, el teclado sigue funcionando. Al volver a
              conectarlo se recupera el foco de la pantalla actual.
            </p>
          </div>
        </div>
      </section>

      <section className="settings-section panel" aria-labelledby="settings-app">
        <div className="panel__head">
          <p className="eyebrow">Aplicación</p>
          <h2 id="settings-app">Sistema</h2>
        </div>
        <div className="setting-row">
          <div>
            <p>BPSteamFit {runtime.appVersion}</p>
            <p className="muted small">Plataforma: {runtime.platform}</p>
          </div>
          <div className="action-row">
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="settings-logs"
              onClick={openLogs}
              disabled={busy}
            >
              <FolderIcon width={18} height={18} /> Abrir carpeta de logs
            </button>
            <button
              type="button"
              className="btn btn--danger"
              data-focusable
              data-focus-id="settings-quit"
              onClick={() => runtime.openDialog({ kind: 'quit' })}
            >
              Salir de la aplicación
            </button>
          </div>
        </div>
      </section>
    </section>
  )
}
