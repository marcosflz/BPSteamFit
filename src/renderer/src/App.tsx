import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import type {
  AppEventMap,
  AppSettings,
  BootstrapData,
  CatalogGame,
  ProviderStatus,
  SteamStatus
} from '@shared/domain'
import type { BpsApi } from '@shared/ipc'
import { ApiProvider } from './api/ApiContext'
import { AppRuntimeContext, useRuntime, type AppRuntime, type ToastTone } from './runtime/AppRuntime'
import { useGamepad } from './hooks/useGamepad'
import {
  activateFocused,
  focusInitialWithin,
  isTextEntryElement,
  leaveTextEntry,
  moveFocus
} from './lib/focus'
import { isDirectionAction as isNavDirection, type NavAction } from './lib/gamepad'
import { toUiError, detailsText, type UiError } from './lib/errors'
import {
  createNavState,
  navReducer,
  screenKey,
  type Screen
} from './navigation/screens'
import {
  ScreenControlsProvider,
  useScreenControls,
  type RegisterScreenControls,
  type ScreenControls
} from './navigation/ScreenControls'
import type { AppDialog } from './navigation/dialogs'
import { BootScreen } from './components/Skeleton'
import { Header } from './components/Header'
import { HintBar } from './components/HintBar'
import { ToastStack, type ToastMessage } from './components/Toasts'
import { LibraryScreen } from './screens/LibraryScreen'
import { GameScreen } from './screens/GameScreen'
import { InstallScreen } from './screens/InstallScreen'
import { IdentityScreen } from './screens/IdentityScreen'
import { ArtworkScreen } from './screens/ArtworkScreen'
import { SteamScreen } from './screens/SteamScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { DialogHost } from './dialogs/DialogHost'
import { useFocusRestore } from './hooks/useFocusRestore'

export interface AppProps {
  /** Inyectable en pruebas. En producción se usa window.bps. */
  api?: BpsApi
  initialScreen?: Screen
}

function MissingApi(): React.JSX.Element {
  return (
    <div className="app-shell app-shell--boot">
      <div className="boot-screen boot-screen--error">
        <span className="brand-mark brand-mark--large" aria-hidden="true">
          BP
        </span>
        <h1>BPSteamFit</h1>
        <p>
          No se encontró la API de la aplicación. Abre la interfaz desde Electron; el puente
          <code> window.bps </code>no está disponible en este contexto.
        </p>
      </div>
    </div>
  )
}

export function App(props: AppProps): React.JSX.Element {
  const resolved = props.api ?? (typeof window !== 'undefined' ? window.bps : undefined)
  if (!resolved) return <MissingApi />
  return (
    <ApiProvider api={resolved}>
      <AppInner api={resolved} initialScreen={props.initialScreen} />
    </ApiProvider>
  )
}

function AppInner(props: { api: BpsApi; initialScreen?: Screen }): React.JSX.Element {
  const api = props.api
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<UiError | null>(null)
  const [nav, dispatchNav] = useReducer(navReducer, props.initialScreen ?? { type: 'library' }, createNavState)
  const [dialog, setDialog] = useState<AppDialog | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastId = useRef(0)
  const loadSequence = useRef(0)
  const eventRefreshTimer = useRef<number | null>(null)
  const controlsRef = useRef<ScreenControls | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  const toast = useCallback((tone: ToastTone, message: string): void => {
    toastId.current += 1
    const id = toastId.current
    setToasts((previous) => [...previous.slice(-2), { id, tone, message }])
  }, [])

  const dismissToast = useCallback((id: number): void => {
    setToasts((previous) => previous.filter((entry) => entry.id !== id))
  }, [])

  const loadBootstrap = useCallback(async (): Promise<void> => {
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    setLoading(true)
    setLoadError(null)
    try {
      const data = await api.getBootstrap()
      if (loadSequence.current === sequence) {
        setBootstrap(data)
        setLoading(false)
      }
    } catch (caught) {
      if (loadSequence.current === sequence) {
        setLoadError(toUiError(caught))
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    void loadBootstrap()
  }, [loadBootstrap])

  const navigate = useCallback((screen: Screen): void => {
    dispatchNav({ type: 'navigate', screen })
    setDialog(null)
  }, [])

  const back = useCallback((): void => {
    dispatchNav({ type: 'back' })
  }, [])

  const updateGame = useCallback((game: CatalogGame): void => {
    setBootstrap((previous) => {
      if (!previous) return previous
      const exists = previous.games.some((entry) => entry.id === game.id)
      return {
        ...previous,
        games: exists
          ? previous.games.map((entry) => (entry.id === game.id ? game : entry))
          : [...previous.games, game]
      }
    })
  }, [])

  const updateSettings = useCallback((settings: AppSettings): void => {
    setBootstrap((previous) => (previous ? { ...previous, settings } : previous))
  }, [])

  const updateSteam = useCallback((steam: SteamStatus): void => {
    setBootstrap((previous) => (previous ? { ...previous, steam } : previous))
  }, [])

  const updateProviders = useCallback((providers: ProviderStatus): void => {
    setBootstrap((previous) => (previous ? { ...previous, providers } : previous))
  }, [])

  const refreshCatalog = useCallback(async (): Promise<CatalogGame[]> => {
    const games = await api.refreshCatalog()
    setBootstrap((previous) => (previous ? { ...previous, games } : previous))
    return games
  }, [api])

  const rescanPackages = useCallback(async (): Promise<CatalogGame[]> => {
    const games = await api.rescanPackages()
    setBootstrap((previous) => (previous ? { ...previous, games } : previous))
    return games
  }, [api])

  const openDialog = useCallback((next: AppDialog): void => setDialog(next), [])
  const closeDialog = useCallback((): void => setDialog(null), [])

  const registerControls = useCallback<RegisterScreenControls>((controls) => {
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [])

  // Eventos del proceso principal: progreso real, catálogo, Steam y avisos.
  useEffect(() => {
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'install:progress') {
        const payload = event.payload as AppEventMap['install:progress']
        setBootstrap((previous) =>
          previous
            ? {
                ...previous,
                games: previous.games.map((game) =>
                  game.id === payload.gameId ? { ...game, install: payload.snapshot } : game
                )
              }
            : previous
        )
        return
      }
      if (event.type === 'steam:changed') {
        updateSteam(event.payload as AppEventMap['steam:changed'])
        return
      }
      if (event.type === 'toast') {
        const payload = event.payload as AppEventMap['toast']
        toast(payload.type, payload.message)
        return
      }
      if (event.type === 'catalog:changed') {
        if (eventRefreshTimer.current !== null) window.clearTimeout(eventRefreshTimer.current)
        eventRefreshTimer.current = window.setTimeout(() => {
          eventRefreshTimer.current = null
          void refreshCatalog().catch((caught: unknown) => {
            toast('error', toUiError(caught).message)
          })
        }, 320)
      }
    })
    return () => {
      unsubscribe()
      if (eventRefreshTimer.current !== null) {
        window.clearTimeout(eventRefreshTimer.current)
        eventRefreshTimer.current = null
      }
    }
  }, [api, refreshCatalog, toast, updateSteam])

  const screenRoot = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-nav-root]') ??
    document.querySelector<HTMLElement>('[data-boot-root]')
  const modalRoot = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-modal-root]')

  const handleNavAction = (action: NavAction): void => {
    const activeDialog = dialogRef.current
    const modal = modalRoot()

    if (activeDialog) {
      if (action === 'back') {
        if (isTextEntryElement(document.activeElement)) {
          leaveTextEntry(modal)
        } else {
          setDialog(null)
        }
        return
      }
      if (isNavDirection(action)) {
        if (!isTextEntryElement(document.activeElement)) moveFocus(modal, action)
        return
      }
      if (action === 'accept') {
        if (!isTextEntryElement(document.activeElement)) activateFocused(modal)
      }
      return
    }

    if (isTextEntryElement(document.activeElement)) {
      if (action === 'back') leaveTextEntry(screenRoot())
      return
    }

    const controls = controlsRef.current
    if (controls?.onAction?.(action) === true) return

    if (action === 'back') {
      if (controls?.onBack) controls.onBack()
      else dispatchNav({ type: 'back' })
      return
    }
    if (isNavDirection(action)) {
      moveFocus(screenRoot(), action)
      return
    }
    if (action === 'accept') {
      activateFocused(screenRoot())
      return
    }
    if (action === 'menu') {
      if (navRef.current.current.type === 'settings') dispatchNav({ type: 'back' })
      else navigate({ type: 'settings' })
    }
  }

  const actionRef = useRef(handleNavAction)
  actionRef.current = handleNavAction
  const { connected } = useGamepad((action) => actionRef.current(action))

  const wasConnected = useRef(false)
  useEffect(() => {
    if (wasConnected.current === connected) return
    wasConnected.current = connected
    if (connected) {
      toast('info', 'Mando conectado. El foco vuelve a la pantalla actual.')
      const active = document.activeElement
      const root = modalRoot() ?? screenRoot()
      if (
        root &&
        (!(active instanceof HTMLElement) || active === document.body || !root.contains(active))
      ) {
        focusInitialWithin(root)
      }
    } else {
      toast('info', 'Mando desconectado. Puedes seguir con el teclado.')
    }
  }, [connected, toast])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      const textEntry = target instanceof HTMLElement && isTextEntryElement(target)

      if (event.key === 'Tab') return
      if (textEntry) {
        if (event.key === 'Escape') {
          event.preventDefault()
          actionRef.current('back')
        }
        return
      }

      let action: NavAction | null = null
      if (event.key === 'ArrowUp') action = 'up'
      else if (event.key === 'ArrowDown') action = 'down'
      else if (event.key === 'ArrowLeft') action = 'left'
      else if (event.key === 'ArrowRight') action = 'right'
      else if (event.key === 'Enter' || event.key === ' ') action = 'accept'
      else if (event.key === 'Escape') action = 'back'

      if (!action) return
      if (event.repeat && (action === 'accept' || action === 'back')) return
      event.preventDefault()
      actionRef.current(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onWindowFocus = (): void => {
      const root = modalRoot() ?? screenRoot()
      const active = document.activeElement
      if (
        root &&
        (!(active instanceof HTMLElement) ||
          active === document.body ||
          !root.contains(active) ||
          !active.matches('[data-focusable]'))
      ) {
        focusInitialWithin(root)
      }
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [])

  const runtime = useMemo<AppRuntime | null>(() => {
    if (!bootstrap) return null
    return {
      api,
      appVersion: bootstrap.appVersion,
      platform: bootstrap.platform,
      settings: bootstrap.settings,
      providers: bootstrap.providers,
      steam: bootstrap.steam,
      games: bootstrap.games,
      connected,
      screen: nav.current,
      navigate,
      back,
      updateGame,
      updateSettings,
      updateSteam,
      updateProviders,
      refreshCatalog,
      rescanPackages,
      toast,
      openDialog,
      closeDialog
    }
  }, [
    api,
    bootstrap,
    connected,
    nav.current,
    navigate,
    back,
    updateGame,
    updateSettings,
    updateSteam,
    updateProviders,
    refreshCatalog,
    rescanPackages,
    toast,
    openDialog,
    closeDialog
  ])

  if (loading && !bootstrap) {
    return (
      <div className="app-shell app-shell--boot">
        <BootScreen />
      </div>
    )
  }

  if (loadError && !bootstrap) {
    return (
      <div className="app-shell app-shell--boot">
        <div className="boot-screen boot-screen--error" data-boot-root>
          <span className="brand-mark brand-mark--large" aria-hidden="true">
            BP
          </span>
          <h1>No se pudo cargar la biblioteca</h1>
          <p>{loadError.message}</p>
          {loadError.hint ? <p className="muted">{loadError.hint}</p> : null}
          <p className="muted small">Código: {loadError.code}</p>
          {detailsText(loadError) ? (
            <details className="technical-details">
              <summary data-focusable data-focus-id="boot-technical">Detalles técnicos</summary>
              <pre>{detailsText(loadError)}</pre>
            </details>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            data-focusable
            data-focus-id="boot-retry"
            data-autofocus
            autoFocus
            onClick={() => void loadBootstrap()}
          >
            Reintentar
          </button>
        </div>
      </div>
    )
  }

  if (!bootstrap || !runtime) {
    return (
      <div className="app-shell app-shell--boot">
        <BootScreen />
      </div>
    )
  }

  const current = nav.current
  const gameId = 'gameId' in current ? current.gameId : null
  const game = gameId ? bootstrap.games.find((entry) => entry.id === gameId) ?? null : null
  const missingGame = gameId !== null && !game

  let screenContent: React.JSX.Element
  if (current.type === 'library') screenContent = <LibraryScreen key="library" />
  else if (current.type === 'steam') screenContent = <SteamScreen key="steam" />
  else if (current.type === 'settings') screenContent = <SettingsScreen key="settings" />
  else if (!game) screenContent = <MissingGame key="missing" />
  else if (current.type === 'game') screenContent = <GameScreen key={screenKey(current)} game={game} />
  else if (current.type === 'install') screenContent = <InstallScreen key={screenKey(current)} game={game} />
  else if (current.type === 'identity') screenContent = <IdentityScreen key={screenKey(current)} game={game} />
  else screenContent = <ArtworkScreen key={screenKey(current)} game={game} />

  const tabsEnabled =
    (current.type === 'library' && bootstrap.games.length > 0) || current.type === 'artwork'
  const tabHint = current.type === 'library' ? 'Cambiar filtro' : 'Cambiar categoría'

  return (
    <AppRuntimeContext.Provider value={runtime}>
      <ScreenControlsProvider register={registerControls}>
        <div className="app-shell">
          <div className="app-nav" data-nav-root>
            <Header />
            <main className={`stage ${missingGame ? 'stage--empty' : ''}`}>{screenContent}</main>
          </div>
          <HintBar
            dialogOpen={Boolean(dialog)}
            tabsEnabled={tabsEnabled}
            tabHint={tabsEnabled ? tabHint : 'Sin pestañas'}
            backEnabled={current.type !== 'library'}
            startLabel={current.type === 'settings' ? 'Volver' : 'Ajustes'}
          />
          {dialog ? <DialogHost dialog={dialog} /> : null}
          <ToastStack toasts={toasts} onDismiss={dismissToast} />
        </div>
      </ScreenControlsProvider>
    </AppRuntimeContext.Provider>
  )
}

function MissingGame(): React.JSX.Element {
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  useFocusRestore(rootRef, 'missing-game')
  useScreenControls({ onBack: () => runtime.back() })
  return (
    <section ref={rootRef} className="screen empty-state" data-screen-root>
      <p className="eyebrow">Catálogo</p>
      <h1>Este juego ya no está disponible</h1>
      <p className="muted">Puede que se haya retirado del catálogo o que el paquete se haya movido.</p>
      <button
        type="button"
        className="btn btn--primary"
        data-focusable
        data-autofocus
        onClick={runtime.back}
      >
        Volver a la biblioteca
      </button>
    </section>
  )
}
