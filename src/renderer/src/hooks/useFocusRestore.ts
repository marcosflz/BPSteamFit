import { useEffect, useRef, type RefObject } from 'react'
import {
  findByFocusId,
  focusElement,
  focusInitialWithin,
  getFocusables,
  recallFocus,
  rememberFocus
} from '../lib/focus'

export interface FocusRestoreOptions {
  ready?: boolean
}

/**
 * Enfoca el primer control al entrar en una pantalla y recuerda el último foco
 * de esa pantalla para restaurarlo al volver. El foco se guarda en cada
 * `focusin`, no solo al desmontar, para sobrevivir al orden de limpieza de React.
 */
export function useFocusRestore(
  rootRef: RefObject<HTMLElement | null>,
  scope: string,
  options: FocusRestoreOptions = {}
): void {
  const ready = options.ready ?? true
  const restored = useRef(false)

  useEffect(() => {
    restored.current = false
  }, [scope])

  useEffect(() => {
    if (!ready || restored.current) return
    const root = rootRef.current
    if (!root) return
    restored.current = true

    const savedId = recallFocus(scope)
    const saved = savedId ? findByFocusId(root, savedId) : null
    if (saved && focusElement(saved)) {
      return
    }
    focusInitialWithin(root)
  }, [ready, rootRef, scope])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const focusId = target.dataset.focusId
      if (focusId) rememberFocus(scope, focusId)
    }
    root.addEventListener('focusin', onFocusIn)
    return () => root.removeEventListener('focusin', onFocusIn)
  }, [rootRef, scope])
}

/** Enfoca dentro de un contenedor tras una transición controlada por la app. */
export function focusWithinNow(root: ParentNode | null): void {
  if (!root) return
  if (root.querySelector('[data-autofocus]')) {
    const target = root.querySelector<HTMLElement>('[data-autofocus]')
    if (target) {
      focusElement(target)
      return
    }
  }
  const first = getFocusables(root)[0]
  focusElement(first ?? null)
}
