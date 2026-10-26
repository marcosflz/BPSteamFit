import { useEffect, useRef, useState } from 'react'
import type { CatalogGame, IdentityCandidate } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ArtworkVisual } from '../components/ArtworkVisual'
import { ErrorBanner } from '../components/ErrorBanner'
import { OnScreenKeyboard } from '../components/OnScreenKeyboard'
import { SearchIcon } from '../components/icons'
import { focusElement } from '../lib/focus'

function isChosen(game: CatalogGame, candidate: IdentityCandidate): boolean {
  if (game.identity.status !== 'confirmed' && game.identity.status !== 'auto') return false
  return (
    game.identity.provider === candidate.provider &&
    game.identity.providerId === candidate.providerId
  )
}

export function IdentityScreen(props: { game: CatalogGame }): React.JSX.Element {
  const { game } = props
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const hadSearchOpen = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, `identity:${game.id}`)

  const closeSearch = (): void => setSearchOpen(false)

  useScreenControls({
    onBack: () => {
      if (searchOpen) {
        closeSearch()
        return
      }
      runtime.back()
    }
  })

  useEffect(() => {
    if (searchOpen) {
      hadSearchOpen.current = true
      return
    }
    if (hadSearchOpen.current) {
      hadSearchOpen.current = false
      focusElement(searchButtonRef.current)
    }
  }, [searchOpen])

  const choose = (candidate: IdentityCandidate): void => {
    void (async () => {
      const result = await run(() => runtime.api.chooseIdentity(game.id, candidate.key))
      if (result.ok) {
        runtime.updateGame(result.value)
        runtime.toast(
          'success',
          `Identidad asignada: ${result.value.identity.title ?? candidate.title}.`
        )
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const search = (): void => {
    const term = query.trim()
    if (!term) return
    void (async () => {
      const result = await run(() => runtime.api.searchIdentity(game.id, term))
      if (result.ok) {
        runtime.updateGame(result.value)
        setSearchOpen(false)
        runtime.toast(
          'success',
          result.value.identity.candidates.length > 0
            ? 'Búsqueda actualizada.'
            : 'La búsqueda no devolvió candidatos.'
        )
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const refreshMetadata = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.refreshMetadata(game.id))
      if (result.ok) {
        runtime.updateGame(result.value)
        runtime.toast('success', 'Ficha actualizada.')
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const candidates = game.identity.candidates
  const chosenCandidate = candidates.find((candidate) => isChosen(game, candidate))
  const ambiguous = game.identity.status === 'ambiguous'

  return (
    <section
      ref={rootRef}
      className="screen identity-screen"
      data-screen-root
      aria-labelledby="identity-title"
    >
      <div className="screen-head">
        <div>
          <p className="eyebrow">Metadatos</p>
          <h1 id="identity-title">Identidad de {game.name}</h1>
          <p className="screen-head__description">
            Elige el título correcto. La app no decide por ti cuando hay ambigüedad.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="identity-refresh"
            onClick={refreshMetadata}
            disabled={busy}
          >
            Actualizar ficha
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            data-focusable
            data-focus-id="identity-back"
            onClick={() => runtime.back()}
          >
            Volver
          </button>
        </div>
      </div>

      {error ? <ErrorBanner error={error} onRetry={refreshMetadata} retryLabel="Reintentar" /> : null}

      <div className="identity-current panel panel--tight">
        <div>
          <p className="eyebrow">Selección actual</p>
          <h2>
            {chosenCandidate
              ? chosenCandidate.title
              : game.identity.status === 'none'
                ? 'Sin identidad'
                : game.identity.title ?? game.name}
          </h2>
          <p className="muted">
            {game.identity.status === 'ambiguous'
              ? 'Hay varios candidatos y ninguno está confirmado.'
              : game.identity.status === 'auto'
                ? 'Elegida automáticamente por el proveedor de metadatos.'
                : game.identity.status === 'confirmed'
                  ? game.identity.decidedBy === 'manifest'
                    ? 'Identidad fijada por el manifiesto.'
                    : game.identity.decidedBy === 'auto'
                      ? 'Identidad elegida automaticamente y confirmada.'
                      : 'Confirmada por ti.'
                  : 'Todavía no se ha elegido una ficha.'}
          </p>
          {game.identity.provider ? (
            <p className="muted small">
              Proveedor: {game.identity.provider} · {game.identity.providerId}
            </p>
          ) : null}
          {game.identity.message ? <p className="muted small">{game.identity.message}</p> : null}
        </div>
        <div className="identity-current__actions">
          <button
            ref={searchButtonRef}
            type="button"
            className="btn btn--primary"
            data-focusable
            data-focus-id="identity-search-open"
            onClick={() => {
              setSearchOpen(true)
              setQuery(game.metadata?.title ?? game.identity.title ?? game.name)
            }}
            disabled={busy}
          >
            <SearchIcon width={18} height={18} /> Buscar otro título
          </button>
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="identity-clear"
            onClick={() => runtime.openDialog({ kind: 'clear-identity', gameId: game.id })}
            disabled={busy}
          >
            Continuar sin metadatos
          </button>
        </div>
      </div>

      {ambiguous ? (
        <div className="notice notice--warning" role="status">
          <div>
            <strong>Ambigüedad sin resolver</strong>
            <p>
              La búsqueda devolvió {candidates.length} títulos posibles. No se ha seleccionado
              ninguno visualmente: elige el correcto con A o busca de nuevo.
            </p>
          </div>
        </div>
      ) : null}

      {searchOpen ? (
        <section className="search-panel panel" aria-labelledby="identity-search-title">
          <div className="panel__head">
            <p className="eyebrow">Búsqueda</p>
            <h2 id="identity-search-title">Buscar otro título</h2>
            <button
              type="button"
              className="btn btn--small btn--quiet"
              data-focusable
              data-focus-id="identity-search-close"
              onClick={closeSearch}
            >
              Cerrar teclado
            </button>
          </div>
          <OnScreenKeyboard
            value={query}
            onChange={setQuery}
            onSubmit={search}
            submitLabel="Buscar"
            busy={busy}
            onClose={closeSearch}
            ariaLabel="Título a buscar"
          />
        </section>
      ) : null}

      <div className="candidate-head">
        <h2>Candidatos</h2>
        <span className="muted">
          {candidates.length === 0
            ? 'Sin resultados'
            : `${candidates.length} ${candidates.length === 1 ? 'resultado' : 'resultados'}`}
        </span>
      </div>

      {candidates.length === 0 ? (
        <div className="empty-state">
          <p>No hay candidatos para este paquete.</p>
          <p className="muted">
            Prueba a buscar por el título comercial sin edición ni año, o continúa sin metadatos.
          </p>
        </div>
      ) : (
        <div className="candidate-grid" role="list">
          {candidates.map((candidate, index) => {
            const chosen = isChosen(game, candidate) || chosenCandidate?.key === candidate.key
            return (
              <div role="listitem" key={candidate.key}>
                <button
                  type="button"
                  className={`candidate-card ${chosen ? 'candidate-card--chosen' : ''}`}
                  data-focusable
                  data-focus-id={`candidate-${candidate.key}`}
                  data-autofocus={index === 0 && !searchOpen ? true : undefined}
                  aria-pressed={chosen}
                  aria-label={`${candidate.title}${candidate.releaseYear ? `, ${candidate.releaseYear}` : ''}, ${candidate.provider}${chosen ? ', elegido' : ''}`}
                  onClick={() => choose(candidate)}
                  disabled={busy}
                >
                  <span className="candidate-card__art">
                    <ArtworkVisual
                      title={candidate.title}
                      kind="portrait"
                      src={candidate.previewUrl}
                      alt=""
                    />
                  </span>
                  <span className="candidate-card__body">
                    <span className="candidate-card__title">{candidate.title}</span>
                    <span className="candidate-card__meta">
                      {candidate.releaseYear ? `${candidate.releaseYear} · ` : ''}
                      {candidate.provider}
                      {candidate.edition ? ` · ${candidate.edition}` : ''}
                    </span>
                    <span className="candidate-card__foot">
                      {chosen ? <span className="chosen-badge">Elegido</span> : <span className="muted">Pulsa A para elegir</span>}
                      {candidate.verified ? <span className="verified-badge">Verificado</span> : null}
                    </span>
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="identity-footer">
        <p className="muted small">
          Elegir una identidad no borra los metadatos actuales hasta que confirmes un candidato.
          «Continuar sin metadatos» sí los elimina.
        </p>
      </div>
    </section>
  )
}
