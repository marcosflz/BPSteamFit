import type { StatusTone } from '../lib/status'

export function StatusChip(props: {
  label: string
  tone?: StatusTone
  className?: string
}): React.JSX.Element {
  return (
    <span className={`status-chip status-chip--${props.tone ?? 'muted'} ${props.className ?? ''}`}>
      <span className="status-chip__dot" aria-hidden="true" />
      {props.label}
    </span>
  )
}
