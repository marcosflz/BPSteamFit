import { useEffect, useRef, useState } from 'react'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { findByFocusId, focusElement } from '../lib/focus'
import {
  LIBRARY_FILTERS,
  matchesLibraryFilter,
  type LibraryFilter
} from '../lib/status'
import { GameCard } from '../components/GameCard'
import { SectionHeader } from '../components/SectionHeader'
import { ErrorBanner } from '../components/ErrorBanner'
import { FolderIcon, RefreshIcon } from '../components/icons'

type FilterId = LibraryFilter['id']

export function LibraryScreen(): React.JSX.Element {
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<FilterId>('all')
  const tabFocusRequested = useRef(false)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, 'library')

  const games = runtime.games
  const filtered = games.filter((game) => matchesLibraryFilter(game, filter))
  const readyCount = games.filter((game) => game.install.state === 'installed').length

  const selectFilter = (next: FilterId, moveFocusToTab: boolean): void => {
    tabFocusRequested.current = moveFocusToTab
    setFilter(next)
  }

  const cycleFilter = (delta: number): void => {
    const currentIndex = LIBRARY_FILTERS.findIndex((entry) => entry.id === filter)
    const nextIndex = (currentIndex + delta + LIBRARY_FILTERS.length) % LIBRARY_FILTERS.length
    const next = LIBRARY_FILTERS[nextIndex]
    if (next) selectFilter(next.id, true)
  }

  useEffect(() => {
    if (!tabFocusRequested.current) return
    tabFocusRequested.current = false
    focusElement(findByFocusId(rootRef.current ?? document, `library-filter-${filter}`))
  }, [filter])

  useScreenControls({
    onAction: (action) => {
      if (games.length === 0) return false
      if (action === 'tabPrev') {
        cycleFilter(-1)
        return true
      }
      if (action === 'tabNext') {
        cycleFilter(1)
        return true
      }
      return false
    },
    onBack: () => undefined
  })

  const addFolder = (): void => {
    void (async () => {
      const result = await run(async () => {
        const settings = await runtime.api.addPackageFolder()
        if (!settings) return false
        runtime.updateSettings(settings)
        await runtime.rescanPackages()
        return true
      })
      if (!result.ok) runtime.toast('error', result.error.message)
      else if (result.value) runtime.toast('success', 'Carpeta añadida. Catálogo actualizado.')
    })()
  }

  const importPackage = (): void => {
    void (async () => {
      const result = await run(async () => {
        const game = await runtime.api.importPackageFile()
        if (!game) return false
        await runtime.refreshCatalog()
        return true
      })
      if (!result.ok) runtime.toast('error', result.error.message)
      else if (result.value) runtime.toast('success', 'Paquete importado. Catálogo actualizado.')
    })()
  }

  const refresh = (): void => {
    void (async () => {
      const result = await run(async () => {
        await runtime.rescanPackages()
        return true
      })
      if (!result.ok) runtime.toast('error', result.error.message)
      else runtime.toast('success', 'Catálogo actualizado.')
    })()
  }

  const openGame = (gameId: string): void => runtime.navigate({ type: 'game', gameId })

  return (
    <section ref={rootRef} className="screen library-screen" data-screen-root aria-labelledby="library-title">
      <SectionHeader
        eyebrow="Biblioteca local"
        title={games.length === 0 ? 'Tu salón está esperando' : 'El salón'}
        titleId="library-title"
        description={
          games.length === 0
            ? 'Añade la carpeta donde guardas tus paquetes .game o importa un archivo suelto. Sin cuentas, sin nube.'
            : `${games.length} ${games.length === 1 ? 'título' : 'títulos'} en el catálogo · ${readyCount} ${readyCount === 1 ? 'listo' : 'listos'} para jugar.`
        }
        actions={
          <div className="action-row">
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="library-add-folder"
              onClick={addFolder}
              disabled={busy}
            >
              <FolderIcon width={18} height={18} /> Añadir carpeta
            </button>
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="library-import"
              onClick={importPackage}
              disabled={busy}
            >
              Importar .game
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              data-focusable
              data-focus-id="library-refresh"
              onClick={refresh}
              disabled={busy}
              aria-label="Actualizar catálogo"
            >
              <RefreshIcon width={18} height={18} />
              <span className="sr-only">Actualizar catálogo</span>
            </button>
          </div>
        }
      />

      {error ? <ErrorBanner error={error} onRetry={refresh} /> : null}

      {games.length === 0 ? (
        <div className="onboarding">
          <div className="onboarding__mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>Empieza por una carpeta</h2>
          <p>
            BPSteamFit lee los paquetes <strong>.game</strong> que ya tienes. No descarga juegos ni
            necesita una cuenta de Steam para mostrar la biblioteca.
          </p>
          <div className="onboarding__actions">
            <button
              type="button"
              className="btn btn--primary btn--large"
              data-focusable
              data-focus-id="onboarding-add-folder"
              data-autofocus
              onClick={addFolder}
              disabled={busy}
            >
              Añadir carpeta de paquetes
            </button>
            <button
              type="button"
              className="btn btn--large"
              data-focusable
              data-focus-id="onboarding-import"
              onClick={importPackage}
              disabled={busy}
            >
              Importar un archivo .game
            </button>
          </div>
          <p className="onboarding__hint">
            Los selectores de carpetas y archivos son ventanas del sistema; si el mando no responde
            en ellos, usa el teclado o el ratón. Después podrás revisar el catálogo desde Ajustes o
            con el botón Actualizar.
          </p>
        </div>
      ) : (
        <>
          <div className="filter-bar" role="tablist" aria-label="Filtrar biblioteca">
            {LIBRARY_FILTERS.map((entry) => {
              const count = games.filter((game) => matchesLibraryFilter(game, entry.id)).length
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.id}
                  className={`filter-tab ${filter === entry.id ? 'filter-tab--active' : ''}`}
                  data-focusable
                  data-focus-id={`library-filter-${entry.id}`}
                  onClick={() => selectFilter(entry.id, false)}
                >
                  {entry.label}
                  <span className="filter-tab__count">{count}</span>
                </button>
              )
            })}
          </div>

          {filtered.length === 0 ? (
            <div className="empty-filter">
              <p>No hay juegos en este filtro.</p>
              <button
                type="button"
                className="btn"
                data-focusable
                data-focus-id="library-empty-all"
                data-autofocus
                onClick={() => selectFilter('all', false)}
              >
                Ver todo el salón
              </button>
            </div>
          ) : (
            <div className="game-grid" aria-label="Biblioteca de juegos">
              {filtered.map((game, index) => (
                <GameCard
                  key={game.id}
                  game={game}
                  autoFocus={index === 0 && filter === 'all'}
                  onOpen={openGame}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
