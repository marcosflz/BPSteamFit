import { useEffect } from 'react'
import type { ToastTone } from '../runtime/AppRuntime'

export interface ToastMessage {
  id: number
  tone: ToastTone
  message: string
}

function ToastItem(props: {
  toast: ToastMessage
  onDismiss: (id: number) => void
}): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => props.onDismiss(props.toast.id), 5200)
    return () => window.clearTimeout(timer)
  }, [props.onDismiss, props.toast.id])

  return (
    <div className={`toast toast--${props.toast.tone}`} role="status">
      <span className="toast__mark" aria-hidden="true" />
      <span>{props.toast.message}</span>
    </div>
  )
}

export function ToastStack(props: {
  toasts: readonly ToastMessage[]
  onDismiss: (id: number) => void
}): React.JSX.Element {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {props.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={props.onDismiss} />
      ))}
    </div>
  )
}
