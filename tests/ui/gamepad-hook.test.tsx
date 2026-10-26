// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useGamepad } from '../../src/renderer/src/hooks/useGamepad'
import type { NavAction } from '../../src/renderer/src/lib/gamepad'

function makePad(): Gamepad {
  const buttons = Array.from({ length: 17 }, () => ({
    pressed: false,
    touched: false,
    value: 0
  }))
  return {
    id: 'UI Test Pad',
    index: 0,
    connected: false,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons,
    hapticActuators: [],
    vibrationActuator: null
  } as unknown as Gamepad
}

function Harness(props: { onAction: (action: NavAction) => void }): React.JSX.Element {
  const { connected } = useGamepad(props.onAction)
  return <span data-testid="connected">{connected ? 'conectado' : 'sin mando'}</span>
}

interface MutablePad {
  connected: boolean
  buttons: Array<{ pressed: boolean; value: number }>
  axes: number[]
}

const originalGetGamepads = navigator.getGamepads

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: originalGetGamepads
  })
})

describe('hook useGamepad', () => {
  it('detecta conexión, emite A, pierde conexión y limpia el sondeo al desmontar', async () => {
    const pad = makePad() as unknown as MutablePad
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [pad as unknown as Gamepad]
    })
    const actions: NavAction[] = []
    const view = render(<Harness onAction={(action) => actions.push(action)} />)

    expect(screen.getByTestId('connected').textContent).toBe('sin mando')
    pad.connected = true
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('conectado'))
    expect(actions).toEqual([])

    const accept = pad.buttons[0]
    if (!accept) throw new Error('Botón A no disponible en el fake')
    accept.pressed = true
    accept.value = 1
    await waitFor(() => expect(actions).toContain('accept'))
    const countAfterAccept = actions.length

    pad.connected = false
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('sin mando'))

    pad.connected = true
    emptyButtons(pad)
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('conectado'))

    view.unmount()
    const back = pad.buttons[1]
    if (!back) throw new Error('Botón B no disponible en el fake')
    back.pressed = true
    await new Promise((resolve) => window.setTimeout(resolve, 80))
    expect(actions).toHaveLength(countAfterAccept)
  })
})

function emptyButtons(pad: MutablePad): void {
  for (const button of pad.buttons) {
    button.pressed = false
    button.value = 0
  }
}
