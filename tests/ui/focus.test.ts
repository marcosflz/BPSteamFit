// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateFocused,
  findFocusTarget,
  forgetFocus,
  leaveTextEntry,
  moveFocus,
  recallFocus,
  rememberFocus,
  resetFocusMemory,
  type FocusableRect
} from '../../src/renderer/src/lib/focus'

const rects: FocusableRect[] = [
  { id: 'a', left: 0, top: 0, right: 100, bottom: 100 },
  { id: 'b', left: 200, top: 0, right: 300, bottom: 100 },
  { id: 'c', left: 0, top: 150, right: 100, bottom: 250 },
  { id: 'd', left: 200, top: 150, right: 300, bottom: 250 }
]

beforeEach(() => {
  resetFocusMemory()
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('navegación espacial geométrica', () => {
  it('elige el vecino correcto en las cuatro direcciones', () => {
    expect(findFocusTarget(rects, 'a', 'right')).toBe('b')
    expect(findFocusTarget(rects, 'b', 'left')).toBe('a')
    expect(findFocusTarget(rects, 'a', 'down')).toBe('c')
    expect(findFocusTarget(rects, 'd', 'up')).toBe('b')
    expect(findFocusTarget(rects, 'c', 'right')).toBe('d')
  })

  it('no envuelve en los límites', () => {
    expect(findFocusTarget(rects, 'a', 'up')).toBeNull()
    expect(findFocusTarget(rects, 'a', 'left')).toBeNull()
    expect(findFocusTarget(rects, 'b', 'right')).toBeNull()
    expect(findFocusTarget(rects, 'd', 'down')).toBeNull()
  })

  it('prefiere el elemento más alineado antes que el más cercano en diagonal', () => {
    const items: FocusableRect[] = [
      { id: 'origin', left: 0, top: 0, right: 100, bottom: 100 },
      { id: 'diagonal', left: 100, top: 100, right: 200, bottom: 200 },
      { id: 'aligned', left: 110, top: 0, right: 210, bottom: 100 }
    ]
    expect(findFocusTarget(items, 'origin', 'right')).toBe('aligned')
  })
})

describe('foco en el DOM', () => {
  it('mueve el foco en orden DOM cuando no hay layout (jsdom) y respeta límites', () => {
    document.body.innerHTML = `
      <div id="nav">
        <button data-focusable data-focus-id="one">Uno</button>
        <button data-focusable data-focus-id="two">Dos</button>
        <button data-focusable data-focus-id="three">Tres</button>
      </div>
    `
    const root = document.getElementById('nav')
    const one = document.querySelector<HTMLElement>('[data-focus-id="one"]')
    const two = document.querySelector<HTMLElement>('[data-focus-id="two"]')
    const three = document.querySelector<HTMLElement>('[data-focus-id="three"]')
    expect(root && one && two && three).toBeTruthy()
    if (!root || !one || !two || !three) return

    one.focus()
    expect(moveFocus(root, 'right').target).toBe(two)
    expect(document.activeElement).toBe(two)
    expect(moveFocus(root, 'down').target).toBe(three)
    expect(document.activeElement).toBe(three)
    expect(moveFocus(root, 'right').moved).toBe(false)
    expect(document.activeElement).toBe(three)
    expect(moveFocus(root, 'up').target).toBe(two)
    expect(document.activeElement).toBe(two)
  })

  it('restaura el foco recordado por pantalla', () => {
    rememberFocus('library', 'game-42')
    expect(recallFocus('library')).toBe('game-42')
    forgetFocus('library')
    expect(recallFocus('library')).toBeNull()
  })

  it('activa el control enfocado y deja los campos de texto sin cerrar el diálogo', () => {
    document.body.innerHTML = `
      <div id="scope">
        <input data-focusable data-focus-id="search" />
        <button data-focusable data-focus-id="action">Acción</button>
      </div>
    `
    const scope = document.getElementById('scope')
    const input = document.querySelector<HTMLInputElement>('[data-focus-id="search"]')
    const button = document.querySelector<HTMLButtonElement>('[data-focus-id="action"]')
    expect(scope && input && button).toBeTruthy()
    if (!scope || !input || !button) return

    let clicks = 0
    button.addEventListener('click', () => {
      clicks += 1
    })

    input.focus()
    expect(leaveTextEntry(scope)).toBe(true)
    expect(document.activeElement).toBe(button)

    button.focus()
    expect(activateFocused(scope)).toBe(true)
    expect(clicks).toBe(1)
  })
})
