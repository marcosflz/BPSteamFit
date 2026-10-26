// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { pickActiveGamepad, type NavAction } from '../../src/renderer/src/lib/gamepad'
import { useGamepad } from '../../src/renderer/src/hooks/useGamepad'

interface FakePad {
  index: number
  id: string
  connected: boolean
  mapping: string
  timestamp: number
  axes: number[]
  buttons: Array<{ pressed: boolean; touched: boolean; value: number }>
}

function makePad(index: number, mapping: string, connected = true): FakePad {
  return {
    index,
    id: mapping === 'standard' ? `Xbox ${index}` : `vJoy ${index}`,
    connected,
    mapping,
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }))
  }
}

function installPads(pads: FakePad[]): void {
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => pads as unknown as Gamepad[]
  })
}

const originalGetGamepads = navigator.getGamepads

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: originalGetGamepads
  })
  vi.restoreAllMocks()
})

function Harness(props: { onAction: (action: NavAction) => void }): React.JSX.Element {
  const { connected } = useGamepad(props.onAction)
  return <span data-testid="connected">{connected ? 'conectado' : 'sin mando'}</span>
}

describe('selección de mando entre dispositivos virtuales', () => {
  it('ignora vJoy/joysticks sin mapeo estándar y elige el Xbox estándar', () => {
    const vjoyA = makePad(0, '')
    const vjoyB = makePad(1, '')
    const xbox = makePad(2, 'standard')
    expect(pickActiveGamepad([vjoyA, vjoyB, xbox] as unknown as Gamepad[])).toBe(
      xbox as unknown as Gamepad
    )
    expect(pickActiveGamepad([vjoyA, vjoyB] as unknown as Gamepad[])).toBeNull()
  })

  it('también ignora un dispositivo vJoy que se anuncia con mapping estándar', () => {
    const standardVjoy = { ...makePad(0, 'standard'), id: 'vJoy - Virtual Joystick' }
    const xbox = makePad(2, 'standard')
    expect(
      pickActiveGamepad([standardVjoy, xbox] as unknown as Gamepad[])
    ).toBe(xbox as unknown as Gamepad)
  })

  it('mantiene el mando preferido si no hay actividad y cambia al que recibe entrada', () => {
    const first = makePad(0, 'standard')
    const second = makePad(1, 'standard')
    const pads = [first, second]
    expect(pickActiveGamepad(pads as unknown as Gamepad[], 1)).toBe(second as unknown as Gamepad)
    const button = second.buttons[0]
    if (!button) throw new Error('sin botón')
    button.pressed = true
    button.value = 1
    expect(pickActiveGamepad(pads as unknown as Gamepad[], 0)).toBe(second as unknown as Gamepad)
  })

  it('solo anuncia conexión con un mando estándar y entrega A desde él', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const vjoy = makePad(0, '')
    const xbox = makePad(1, 'standard', false)
    installPads([vjoy, xbox])
    const actions: NavAction[] = []
    render(<Harness onAction={(action) => actions.push(action)} />)
    await new Promise((resolve) => window.setTimeout(resolve, 80))
    expect(screen.getByTestId('connected').textContent).toBe('sin mando')

    xbox.connected = true
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('conectado'))
    const accept = xbox.buttons[0]
    if (!accept) throw new Error('sin botón A')
    accept.pressed = true
    accept.value = 1
    await waitFor(() => expect(actions).toContain('accept'))
  })
})
