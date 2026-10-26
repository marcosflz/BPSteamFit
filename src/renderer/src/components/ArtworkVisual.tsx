import { useEffect, useState, type CSSProperties } from 'react'
import type { ArtworkKind } from '@shared/domain'
import { ARTWORK_LABELS, initials, placeholderHue, safeArtworkUrl } from '../lib/format'

export function ArtworkPlaceholder(props: {
  title: string
  kind: ArtworkKind
  className?: string
  showKind?: boolean
}): React.JSX.Element {
  const hue = placeholderHue(props.title)
  const style = {
    '--ph-hue': String(hue),
    '--ph-hue-two': String((hue + 42) % 360)
  } as CSSProperties
  return (
    <span
      className={`art-placeholder ${props.className ?? ''}`}
      style={style}
      data-testid="artwork-placeholder"
      aria-hidden="true"
    >
      <span className="art-placeholder__frame" />
      <span className="art-placeholder__initials">{initials(props.title)}</span>
      {props.showKind === false ? null : (
        <span className="art-placeholder__kind">{ARTWORK_LABELS[props.kind]}</span>
      )}
    </span>
  )
}

export function ArtworkVisual(props: {
  title: string
  kind: ArtworkKind
  src?: string | null
  alt?: string
  className?: string
  showKind?: boolean
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const safe = safeArtworkUrl(props.src)
  useEffect(() => {
    setFailed(false)
  }, [props.src])
  if (!safe || failed) {
    return (
      <ArtworkPlaceholder
        title={props.title}
        kind={props.kind}
        className={props.className}
        showKind={props.showKind}
      />
    )
  }
  return (
    <img
      className={`art-image ${props.className ?? ''}`}
      src={safe}
      alt={props.alt ?? ''}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
