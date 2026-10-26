// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { App } from '../../src/renderer/src/App'
import { resetFocusMemory } from '../../src/renderer/src/lib/focus'
import { createFakeApi } from './fake-api'
import { makeBootstrap, makeGame } from './fixtures'

interface MutablePad {
  connected: boolean
  index: number
  mapping: string
  buttons: Array<{ pressed: boolean; value: number }>
  axes: number[]
}

function makePad(): MutablePad {
  return {
    connected: true,
    index: 0,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0]
  }
}

function press(pad: MutablePad, index: number, pressed: boolean): void {
  const button = pad.buttons[index]
  if (!button) throw new Error(`Botón ${index} no disponible`)
  button.pressed = pressed
  button.value = pressed ? 1 : 0
}

const originalGetGamepads = navigator.getGamepads

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  resetFocusMemory()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: originalGetGamepads
  })
})

describe('integración de mando con la aplicación', () => {
  it('usa A para abrir una ficha y B para volver restaurando el foco', async () => {
    const pad = makePad()
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [pad as unknown as Gamepad]
    })
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        games: [
          makeGame({ id: 'one', name: 'Primer Juego' }),
          makeGame({ id: 'two', name: 'Segundo Juego' })
        ]
      })
    })
    render(<App api={api} />)

    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    await screen.findByText('Mando conectado')
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-one')
    )

    press(pad, 0, true)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Primer Juego' })).toBeTruthy()
    )

    press(pad, 0, false)
    await new Promise((resolve) => window.setTimeout(resolve, 30))
    press(pad, 1, true)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'El salón' })).toBeTruthy()
    )
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-one')
    )
  })
})
