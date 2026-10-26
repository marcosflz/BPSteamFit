import { useRuntime } from '../runtime/AppRuntime'
import { packageSummary } from '../lib/status'
import { GamepadIcon } from './icons'
import { StatusChip } from './StatusChip'

export function Header(): React.JSX.Element {
  const runtime = useRuntime()
  const pending = runtime.steam.pendingChanges.length
  const packageState = packageSummary(runtime.games)
  const isSteam = runtime.screen.type === 'steam'
  const isSettings = runtime.screen.type === 'settings'

  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        data-focusable
        data-focus-id="nav-brand"
        onClick={() => runtime.navigate({ type: 'library' })}
        aria-label="BPSteamFit, ir a la biblioteca"
      >
        <span className="brand-mark" aria-hidden="true">
          BP
        </span>
        <span className="brand-copy">
          <span className="eyebrow">Salón local</span>
          <span className="brand-name">BPSteamFit</span>
        </span>
      </button>

      <div className="topbar__status">
        <StatusChip label={packageState.label} tone={packageState.tone} />
        <span
          className={`controller-status ${runtime.connected ? 'controller-status--on' : ''}`}
          aria-live="polite"
        >
          <GamepadIcon />
          <span>{runtime.connected ? 'Mando conectado' : 'Sin mando · teclado'}</span>
        </span>
      </div>

      <nav className="topbar__nav" aria-label="Navegación principal">
        <button
          type="button"
          className={`nav-button ${isSteam ? 'nav-button--active' : ''}`}
          data-focusable
          data-focus-id="nav-steam"
          aria-current={isSteam ? 'page' : undefined}
          aria-label={
            pending > 0
              ? `Steam, ${pending} ${pending === 1 ? 'cambio pendiente' : 'cambios pendientes'}`
              : 'Steam'
          }
          onClick={() => runtime.navigate({ type: 'steam' })}
        >
          Steam
          {pending > 0 ? <span className="nav-button__badge">{pending}</span> : null}
        </button>
        <button
          type="button"
          className={`nav-button ${isSettings ? 'nav-button--active' : ''}`}
          data-focusable
          data-focus-id="nav-settings"
          aria-current={isSettings ? 'page' : undefined}
          onClick={() => runtime.navigate({ type: 'settings' })}
        >
          Ajustes
        </button>
      </nav>
    </header>
  )
}
