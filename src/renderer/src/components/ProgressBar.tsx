export function ProgressBar(props: {
  value?: number | null
  indeterminate: boolean
  label: string
  valueText?: string
}): React.JSX.Element {
  if (props.indeterminate) {
    return (
      <div
        className="progress progress--indeterminate"
        role="progressbar"
        aria-label={props.label}
        aria-valuetext={props.valueText ?? 'Progreso indeterminado'}
      >
        <span className="progress__bar" />
      </div>
    )
  }

  const raw = props.value ?? 0
  const clamped = Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 0))
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 10) / 10}
      aria-valuetext={props.valueText}
    >
      <span className="progress__bar" style={{ width: `${clamped}%` }} />
    </div>
  )
}
