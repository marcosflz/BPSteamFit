/**
 * Navegación espacial y memoria de foco.
 *
 * La interfaz no usa el cursor como mecanismo principal. Cada control
 * interactivo declara `data-focusable` y, opcionalmente, `data-focus-id` y
 * `data-autofocus`. La navegación usa geometría real; cuando no hay layout
 * (por ejemplo en jsdom) cae a un orden DOM determinista.
 */

import type { NavDirection } from './gamepad'

export interface FocusableRect {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

const memory = new Map<string, string>()

export function rememberFocus(scope: string, focusId: string): void {
  if (focusId) memory.set(scope, focusId)
}

export function recallFocus(scope: string): string | null {
  return memory.get(scope) ?? null
}

export function forgetFocus(scope: string): void {
  memory.delete(scope)
}

/** Solo para pruebas: evita que el foco de un test contamine el siguiente. */
export function resetFocusMemory(): void {
  memory.clear()
}

export function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(element.type)
  }
  if (element instanceof HTMLSelectElement) return true
  return (element as HTMLElement).isContentEditable === true
}

export function isElementVisible(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
    return false
  }
  if (element.closest('[hidden], [aria-hidden="true"]')) return false
  const style = typeof window !== 'undefined' && window.getComputedStyle
    ? window.getComputedStyle(element)
    : null
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  return true
}

export function getFocusables(root: ParentNode): HTMLElement[] {
  if (!root || !('querySelectorAll' in root)) return []
  return Array.from(root.querySelectorAll<HTMLElement>('[data-focusable]')).filter(isElementVisible)
}

export function findByFocusId(root: ParentNode, focusId: string): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>('[data-focus-id]')
  for (const candidate of candidates) {
    if (candidate.dataset.focusId === focusId) return candidate
  }
  return null
}

export function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element || !element.isConnected) return false
  try {
    element.focus({ preventScroll: true })
  } catch {
    element.focus()
  }
  if (typeof element.scrollIntoView === 'function') {
    try {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    } catch {
      // Algunos motores embebidos no implementan opciones.
    }
  }
  return document.activeElement === element
}

export function focusInitialWithin(root: ParentNode): HTMLElement | null {
  const automatic = Array.from(root.querySelectorAll<HTMLElement>('[data-autofocus]')).find(
    (element) => isElementVisible(element)
  )
  const target = automatic ?? getFocusables(root)[0] ?? null
  focusElement(target)
  return target
}

function center(rect: FocusableRect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

/**
 * Elige el siguiente foco en la dirección indicada usando los centros de los
 * rectángulos. No envuelve en los límites. La distancia perpendicular pesa más
 * para favorecer la alineación de filas y columnas.
 */
export function findFocusTarget(
  items: readonly FocusableRect[],
  currentId: string,
  direction: NavDirection
): string | null {
  const current = items.find((item) => item.id === currentId)
  if (!current) return null
  const origin = center(current)
  let bestId: string | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const item of items) {
    if (item.id === currentId) continue
    const candidate = center(item)
    const dx = candidate.x - origin.x
    const dy = candidate.y - origin.y

    let primary: number
    let perpendicular: number
    if (direction === 'right') {
      if (dx <= 2) continue
      primary = dx
      perpendicular = Math.abs(dy)
    } else if (direction === 'left') {
      if (dx >= -2) continue
      primary = -dx
      perpendicular = Math.abs(dy)
    } else if (direction === 'down') {
      if (dy <= 2) continue
      primary = dy
      perpendicular = Math.abs(dx)
    } else {
      if (dy >= -2) continue
      primary = -dy
      perpendicular = Math.abs(dx)
    }

    const score = primary + perpendicular * 2.4
    if (score < bestScore) {
      bestScore = score
      bestId = item.id
    }
  }

  return bestId
}

function rectFor(element: HTMLElement, index: number): FocusableRect {
  const rect = element.getBoundingClientRect()
  return {
    id: element.dataset.focusId ?? element.id ?? `focus-${index}`,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom
  }
}

export interface MoveFocusResult {
  moved: boolean
  target: HTMLElement | null
}

/**
 * Mueve el foco dentro de `root`. Devuelve `moved: false` en un límite para que
 * el llamador pueda decidir si hace otra cosa (por ejemplo, nada).
 */
export function moveFocus(root: ParentNode | null, direction: NavDirection): MoveFocusResult {
  if (!root) return { moved: false, target: null }
  const items = getFocusables(root)
  if (items.length === 0) return { moved: false, target: null }

  const active = document.activeElement
  let currentIndex = active instanceof HTMLElement ? items.indexOf(active) : -1
  if (currentIndex < 0) {
    const first = items[0]
    if (!first) return { moved: false, target: null }
    focusElement(first)
    return { moved: true, target: first }
  }

  const rects = items.map(rectFor)
  const hasLayout = rects.some(
    (rect) => rect.right - rect.left > 0.5 || rect.bottom - rect.top > 0.5
  )

  if (hasLayout) {
    const current = rects[currentIndex]
    if (!current) return { moved: false, target: null }
    const targetId = findFocusTarget(rects, current.id, direction)
    if (!targetId) return { moved: false, target: null }
    const target = items.find((element, index) => rects[index]?.id === targetId) ?? null
    if (!target) return { moved: false, target: null }
    focusElement(target)
    return { moved: true, target }
  }

  // Fallback sin layout: orden DOM, sin envolver. Es el modo que usan las
  // pruebas de jsdom y también sirve en pantallas sin geometría fiable.
  const delta = direction === 'left' || direction === 'up' ? -1 : 1
  const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta))
  if (nextIndex === currentIndex) return { moved: false, target: null }
  const target = items[nextIndex]
  if (!target) return { moved: false, target: null }
  focusElement(target)
  return { moved: true, target }
}

/** Activa el control enfocado; si no hay foco válido, enfoca el primero. */
export function activateFocused(root: ParentNode | null): boolean {
  if (!root) return false
  const active = document.activeElement
  if (active instanceof HTMLElement && root.contains(active) && !isTextEntryElement(active)) {
    active.click()
    return true
  }
  focusInitialWithin(root)
  return false
}

/** Sale de un campo de texto sin cerrar la pantalla o el diálogo. */
export function leaveTextEntry(root: ParentNode | null): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !isTextEntryElement(active)) return false
  active.blur()
  if (root) {
    const focusables = getFocusables(root)
    const index = focusables.indexOf(active)
    const target =
      (index >= 0 ? focusables[index + 1] : undefined) ??
      (index > 0 ? focusables[index - 1] : undefined) ??
      focusables[0] ??
      null
    focusElement(target)
  }
  return true
}
