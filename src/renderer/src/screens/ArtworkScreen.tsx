import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtworkGalleryItem, ArtworkKind, CatalogGame } from '@shared/domain'
import { ARTWORK_KINDS } from '@shared/domain'
import { useRuntime } from '../runtime/AppRuntime'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useFocusRestore } from '../hooks/useFocusRestore'
import { useScreenControls } from '../navigation/ScreenControls'
import { ArtworkVisual } from '../components/ArtworkVisual'
import { ErrorBanner } from '../components/ErrorBanner'
import { GallerySkeleton } from '../components/Skeleton'
import { ImageIcon, RefreshIcon } from '../components/icons'
import { toUiError, type UiError } from '../lib/errors'
import { findByFocusId, focusElement } from '../lib/focus'
import { ARTWORK_LABELS, formatDateTime } from '../lib/format'

function galleryAspect(kind: ArtworkKind): string {
  if (kind === 'portrait') return 'gallery-tile--portrait'
  if (kind === 'icon' || kind === 'logo') return 'gallery-tile--square'
  return 'gallery-tile--wide'
}

export function ArtworkScreen(props: { game: CatalogGame }): React.JSX.Element {
  const { game } = props
  const runtime = useRuntime()
  const rootRef = useRef<HTMLElement>(null)
  const [kind, setKind] = useState<ArtworkKind>('portrait')
  const [gallery, setGallery] = useState<ArtworkGalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [galleryError, setGalleryError] = useState<UiError | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const tabFocusRequested = useRef(false)
  const requestSequence = useRef(0)
  const { busy, error, run } = useAsyncAction()
  useFocusRestore(rootRef, `artwork:${game.id}`)

  const current = game.artwork[kind]
  const selectedId = current?.id ?? null

  const loadGallery = useCallback(
    async (targetKind: ArtworkKind): Promise<void> => {
      const sequence = requestSequence.current + 1
      requestSequence.current = sequence
      setLoading(true)
      setGalleryError(null)
      try {
        const items = await runtime.api.getArtworkGallery(game.id, targetKind)
        if (requestSequence.current === sequence) setGallery(items)
      } catch (caught) {
        if (requestSequence.current === sequence) setGalleryError(toUiError(caught))
      } finally {
        if (requestSequence.current === sequence) setLoading(false)
      }
    },
    [game.id, runtime.api]
  )

  useEffect(() => {
    void loadGallery(kind)
  }, [kind, loadGallery, reloadToken])

  const selectKind = (next: ArtworkKind, moveFocus: boolean): void => {
    if (next === kind) return
    tabFocusRequested.current = moveFocus
    setKind(next)
  }

  const cycleKind = (delta: number): void => {
    const index = ARTWORK_KINDS.indexOf(kind)
    const nextIndex = (index + delta + ARTWORK_KINDS.length) % ARTWORK_KINDS.length
    const next = ARTWORK_KINDS[nextIndex]
    if (next) selectKind(next, true)
  }

  useEffect(() => {
    if (!tabFocusRequested.current) return
    tabFocusRequested.current = false
    focusElement(findByFocusId(rootRef.current ?? document, `artwork-tab-${kind}`))
  }, [kind])

  useScreenControls({
    onAction: (action) => {
      if (action === 'tabPrev') {
        cycleKind(-1)
        return true
      }
      if (action === 'tabNext') {
        cycleKind(1)
        return true
      }
      return false
    },
    onBack: () => runtime.back()
  })

  const selectArtwork = (item: ArtworkGalleryItem): void => {
    void (async () => {
      const result = await run(() => runtime.api.selectArtwork(game.id, kind, item.id))
      if (result.ok) {
        runtime.updateGame(result.value)
        setGallery((previous) =>
          previous.map((entry) => ({ ...entry, selected: entry.id === item.id }))
        )
        runtime.toast('success', 'Imagen seleccionada.')
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const reset = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.resetArtwork(game.id, kind))
      if (result.ok) {
        runtime.updateGame(result.value)
        setReloadToken((value) => value + 1)
        runtime.toast('success', 'Selección automática restaurada.')
      } else {
        runtime.toast('error', result.error.message)
      }
    })()
  }

  const importLocal = (): void => {
    void (async () => {
      const result = await run(() => runtime.api.importLocalArtwork(game.id, kind))
      if (!result.ok) {
        runtime.toast('error', result.error.message)
        return
      }
      if (!result.value) return
      runtime.updateGame(result.value)
      setReloadToken((value) => value + 1)
      runtime.toast('success', 'Imagen local importada.')
    })()
  }

  return (
    <section
      ref={rootRef}
      className="screen artwork-screen"
      data-screen-root
      aria-labelledby="artwork-title"
    >
      <div className="screen-head">
        <div>
          <p className="eyebrow">Presentación</p>
          <h1 id="artwork-title">Imágenes de {game.metadata?.title ?? game.name}</h1>
          <p className="screen-head__description">
            Portada, fondo, logo e icono del salón. La selección manual se conserva hasta que la
            cambies o restaures la automática.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="artwork-import"
            onClick={importLocal}
            disabled={busy}
          >
            <ImageIcon width={18} height={18} /> Importar archivo
          </button>
          <button
            type="button"
            className="btn"
            data-focusable
            data-focus-id="artwork-reset"
            onClick={reset}
            disabled={busy}
          >
            <RefreshIcon width={18} height={18} /> Restaurar automático
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            data-focusable
            data-focus-id="artwork-back"
            onClick={() => runtime.back()}
          >
            Volver
          </button>
        </div>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="artwork-tabs" role="tablist" aria-label="Categorías de imágenes">
        {ARTWORK_KINDS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={kind === entry}
            className={`artwork-tab ${kind === entry ? 'artwork-tab--active' : ''}`}
            data-focusable
            data-focus-id={`artwork-tab-${entry}`}
            data-autofocus={kind === entry ? true : undefined}
            onClick={() => selectKind(entry, false)}
          >
            {ARTWORK_LABELS[entry]}
          </button>
        ))}
      </div>

      <div className="artwork-current panel panel--tight">
        <div className="artwork-current__preview">
          <ArtworkVisual
            title={game.metadata?.title ?? game.name}
            kind={kind}
            src={current?.previewUrl}
            alt={`${ARTWORK_LABELS[kind]} actual`}
            showKind={false}
          />
        </div>
        <div className="artwork-current__copy">
          <p className="eyebrow">Selección actual</p>
          <h2>{selectionTitle(kind)}</h2>
          {current ? (
            <>
              <p className="muted">
                {current.source === 'manual' ? 'Archivo o elección manual' : 'Proveedor de metadatos'} ·{' '}
                {current.provider}
                {current.width && current.height ? ` · ${current.width}×${current.height}` : ''}
              </p>
              <p className="muted small">Añadida: {formatDateTime(current.createdAt) ?? current.createdAt}</p>
              {current.author ? <p className="muted small">Autor: {current.author}</p> : null}
              {current.attribution ? <p className="muted small">{current.attribution}</p> : null}
              {current.license ? <p className="muted small">{current.license}</p> : null}
            </>
          ) : (
            <p className="muted">
              No hay una imagen seleccionada para esta categoría. Se muestra un marcador local
              elegante hasta que elijas una.
            </p>
          )}
        </div>
      </div>

      {galleryError ? (
        <ErrorBanner
          error={galleryError}
          onRetry={() => setReloadToken((value) => value + 1)}
          retryLabel="Volver a cargar"
        />
      ) : null}

      {loading ? (
        <GallerySkeleton />
      ) : gallery.length === 0 ? (
        <div className="empty-state">
          <p>No hay imágenes disponibles en «{ARTWORK_LABELS[kind]}».</p>
          <p className="muted">
            Puedes importar un archivo local o restaurar la selección automática cuando el
            proveedor tenga resultados.
          </p>
          <div className="action-row">
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="artwork-empty-import"
              onClick={importLocal}
              disabled={busy}
            >
              Importar archivo
            </button>
            <button
              type="button"
              className="btn"
              data-focusable
              data-focus-id="artwork-empty-reset"
              onClick={reset}
              disabled={busy}
            >
              Restaurar automático
            </button>
          </div>
        </div>
      ) : (
        <div className="artwork-grid" aria-label={`Galería de ${ARTWORK_LABELS[kind]}`}>
          {gallery.map((item) => {
            const chosen = item.selected || item.id === selectedId
            const dimensions = item.width && item.height ? `, ${item.width}×${item.height}` : ''
            return (
              <button
                key={item.id}
                type="button"
                className={`gallery-tile ${galleryAspect(kind)} ${chosen ? 'gallery-tile--chosen' : ''}`}
                data-focusable
                data-focus-id={`artwork-item-${item.id}`}
                aria-pressed={chosen}
                aria-label={`${ARTWORK_LABELS[kind]} de ${item.provider}${dimensions}${item.source === 'manual' ? ', importada' : ''}${chosen ? ', seleccionada' : ''}`}
                onClick={() => selectArtwork(item)}
                disabled={busy}
              >
                <ArtworkVisual
                  title={game.metadata?.title ?? game.name}
                  kind={kind}
                  src={item.previewUrl}
                  alt=""
                  showKind={false}
                />
                <span className="gallery-tile__footer">
                  <span>{item.provider}</span>
                  {chosen ? <span className="chosen-badge">Elegida</span> : null}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function selectionTitle(kind: ArtworkKind): string {
  return `${ARTWORK_LABELS[kind]} seleccionada`
}
