export function LibrarySkeleton(): React.JSX.Element {
  return (
    <div className="library-skeleton" aria-label="Cargando biblioteca" role="status">
      <div className="skeleton skeleton--title" />
      <div className="skeleton-grid">
        {Array.from({ length: 7 }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton skeleton--poster" />
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line skeleton--short" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function GallerySkeleton(): React.JSX.Element {
  return (
    <div className="gallery-skeleton" aria-label="Cargando imágenes" role="status">
      {Array.from({ length: 8 }, (_, index) => (
        <div className="skeleton skeleton--tile" key={index} />
      ))}
    </div>
  )
}

export function BootScreen(): React.JSX.Element {
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <span className="brand-mark brand-mark--large" aria-hidden="true">
        BP
      </span>
      <p className="eyebrow">Salón local</p>
      <h1>BPSteamFit</h1>
      <p className="boot-screen__status">Preparando tu biblioteca…</p>
      <span className="boot-screen__line" aria-hidden="true" />
    </div>
  )
}
