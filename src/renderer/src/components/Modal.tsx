import { useEffect, useId, useRef, type ReactNode } from 'react'
import { focusElement, focusInitialWithin, getFocusables } from '../lib/focus'
import { CloseIcon } from './icons'

export interface ModalProps {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  size?: 'regular' | 'wide'
}

/**
 * Diálogo modal accesible. Atrapa Tab dentro del panel, enfoca el primer
 * `[data-autofocus]` y restaura el foco anterior al cerrarse. La navegación
 * espacial con mando la resuelve App usando `[data-modal-root]`.
 */
export function Modal(props: ModalProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.classList.add('has-modal')

    const initial =
      node.querySelector<HTMLElement>('[data-autofocus]') ?? getFocusables(node)[0] ?? null
    if (initial) {
      focusElement(initial)
    } else {
      focusInitialWithin(node)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusables = getFocusables(node)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      const currentIndex = active instanceof HTMLElement ? focusables.indexOf(active) : -1
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault()
          focusElement(last)
        }
      } else if (currentIndex === -1 || currentIndex === focusables.length - 1) {
        event.preventDefault()
        focusElement(first)
      }
    }

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof Node && !node.contains(target)) {
        const first = getFocusables(node)[0]
        if (first) focusElement(first)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      document.body.classList.remove('has-modal')
      if (previous?.isConnected) focusElement(previous)
    }
  }, [])

  return (
    <div className="modal-overlay">
      <div
        ref={dialogRef}
        className={`modal modal--${props.size ?? 'regular'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal-root
      >
        <header className="modal__header">
          <div>
            {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
            <h2 id={titleId}>{props.title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => onCloseRef.current()}
            data-focusable
            data-focus-id="modal-close"
            aria-label="Cerrar"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">{props.children}</div>
      </div>
    </div>
  )
}
