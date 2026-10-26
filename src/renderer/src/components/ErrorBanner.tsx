import { AlertIcon } from './icons'
import { detailsText, type UiError } from '../lib/errors'

export function ErrorBanner(props: {
  error: UiError
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
}): React.JSX.Element {
  const details = detailsText(props.error)
  return (
    <div className={`error-banner ${props.compact ? 'error-banner--compact' : ''}`} role="alert">
      <span className="error-banner__icon" aria-hidden="true">
        <AlertIcon />
      </span>
      <div className="error-banner__body">
        <p className="error-banner__message">{props.error.message}</p>
        {props.error.hint ? <p className="error-banner__hint">{props.error.hint}</p> : null}
        <div className="error-banner__actions">
          {props.onRetry ? (
            <button type="button" className="btn btn--small" data-focusable onClick={props.onRetry}>
              {props.retryLabel ?? 'Reintentar'}
            </button>
          ) : null}
          {details ? (
            <details className="technical-details">
              <summary data-focusable data-focus-id={`technical-${props.error.code}`}>
                Código y detalles técnicos
              </summary>
              <p className="technical-details__code">{props.error.code}</p>
              <pre>{details}</pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}
