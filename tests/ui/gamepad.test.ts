// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  createGamepadState,
  GAMEPAD,
  pickActiveGamepad,
  readGamepadFrame,
  stepGamepad,
  type GamepadFrame
} from '../../src/renderer/src/lib/gamepad'

function frame(partial: Partial<GamepadFrame> = {}): GamepadFrame {
  const buttons = Array.from({ length: 17 }, () => false)
  return {
    connected: true,
    buttons,
    axes: { x: 0, y: 0 },
    ...partial
  }
}

function withButtons(pressed: number[], partial: Partial<GamepadFrame> = {}): GamepadFrame {
  const buttons = Array.from({ length: 17 }, () => false)
  for (const index of pressed) buttons[index] = true
  return { connected: true, buttons, axes: { x: 0, y: 0 }, ...partial }
}

function connect(): ReturnType<typeof stepGamepad>['state'] {
  return stepGamepad(createGamepadState(), frame(), 0).state
}

describe('motor de mando', () => {
  it('aplica zona muerta de 0,3 al stick y elige el eje dominante', () => {
    const state = connect()
    const below = stepGamepad(state, frame({ axes: { x: 0.29, y: 0.2 } }), 100)
    expect(below.actions).toEqual([])

    const right = stepGamepad(state, frame({ axes: { x: 0.31, y: 0.2 } }), 100)
    expect(right.actions).toEqual(['right'])
    expect(right.state.direction).toBe('right')

    const down = stepGamepad(state, frame({ axes: { x: 0.2, y: -0.9 } }), 100)
    expect(down.actions).toEqual(['up'])
  })

  it('prioriza la cruceta sobre el stick izquierdo', () => {
    const state = connect()
    const result = stepGamepad(
      state,
      withButtons([GAMEPAD.dpadLeft], { axes: { x: 1, y: 0 } }),
      100
    )
    expect(result.actions).toEqual(['left'])
  })

  it('repite dirección tras 350 ms y cada 110 ms, sin repetir al liberar', () => {
    const state = connect()
    const pressed = frame({ axes: { x: 1, y: 0 } })
    const initial = stepGamepad(state, pressed, 100)
    expect(initial.actions).toEqual(['right'])

    expect(stepGamepad(initial.state, pressed, 200).actions).toEqual([])
    expect(stepGamepad(initial.state, pressed, 449).actions).toEqual([])
    const firstRepeat = stepGamepad(initial.state, pressed, 450)
    expect(firstRepeat.actions).toEqual(['right'])
    expect(stepGamepad(firstRepeat.state, pressed, 559).actions).toEqual([])
    expect(stepGamepad(firstRepeat.state, pressed, 560).actions).toEqual(['right'])

    const released = stepGamepad(firstRepeat.state, frame(), 600)
    expect(released.actions).toEqual([])
    expect(released.state.direction).toBeNull()

    const pressedAgain = stepGamepad(released.state, pressed, 700)
    expect(pressedAgain.actions).toEqual(['right'])
  })

  it('cambia de dirección de inmediato y reinicia la repetición', () => {
    const right = stepGamepad(connect(), frame({ axes: { x: 1, y: 0 } }), 100)
    const up = stepGamepad(right.state, frame({ axes: { x: 0, y: -1 } }), 150)
    expect(up.actions).toEqual(['up'])
    expect(up.state.direction).toBe('up')
    expect(up.state.nextRepeatAt).toBe(500)
  })

  it('emite A/B/Start/Back/LB/RB solo en el flanco de subida', () => {
    const state = connect()
    const a = stepGamepad(state, withButtons([GAMEPAD.accept]), 100)
    expect(a.actions).toEqual(['accept'])
    expect(stepGamepad(a.state, withButtons([GAMEPAD.accept]), 200).actions).toEqual([])
    const releasedA = stepGamepad(a.state, frame(), 300)
    const aAgain = stepGamepad(releasedA.state, withButtons([GAMEPAD.accept]), 400)
    expect(aAgain.actions).toEqual(['accept'])

    expect(stepGamepad(state, withButtons([GAMEPAD.back]), 100).actions).toEqual(['back'])
    expect(stepGamepad(state, withButtons([GAMEPAD.view]), 100).actions).toEqual(['back'])
    expect(stepGamepad(state, withButtons([GAMEPAD.menu]), 100).actions).toEqual(['menu'])
    expect(stepGamepad(state, withButtons([GAMEPAD.tabPrev]), 100).actions).toEqual(['tabPrev'])
    expect(stepGamepad(state, withButtons([GAMEPAD.tabNext]), 100).actions).toEqual(['tabNext'])
    expect(stepGamepad(state, withButtons([GAMEPAD.aux]), 100).actions).toEqual(['aux'])
    expect(stepGamepad(state, withButtons([GAMEPAD.aux2]), 100).actions).toEqual(['aux2'])
  })

  it('no emite acciones al conectar y evita aceptar por un botón ya pulsado', () => {
    const connected = stepGamepad(
      createGamepadState(),
      withButtons([GAMEPAD.accept]),
      100
    )
    expect(connected.actions).toEqual([])
    expect(connected.state.connected).toBe(true)

    const disconnected = stepGamepad(connected.state, { connected: false, buttons: [] }, 200)
    expect(disconnected.actions).toEqual([])
    expect(disconnected.state.connected).toBe(false)

    const reconnected = stepGamepad(
      disconnected.state,
      withButtons([GAMEPAD.accept]),
      300
    )
    expect(reconnected.actions).toEqual([])
    expect(reconnected.state.connected).toBe(true)

    const released = stepGamepad(reconnected.state, frame(), 400)
    const pressed = stepGamepad(released.state, withButtons([GAMEPAD.accept]), 500)
    expect(pressed.actions).toEqual(['accept'])
  })

  it('lee el Gamepad estándar y limpia listeners de botones ausentes', () => {
    const pad = {
      connected: true,
      id: 'Fake Pad',
      index: 0,
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, (_, index) => ({
        pressed: index === 0 || index === 12,
        touched: false,
        value: index === 0 ? 1 : 0
      })),
      axes: [0.1, -0.2, 0, 0]
    } as unknown as Gamepad
    const frameRead = readGamepadFrame(pad)
    expect(frameRead.connected).toBe(true)
    expect(frameRead.buttons[0]).toBe(true)
    expect(frameRead.buttons[12]).toBe(true)
    expect(frameRead.buttons[1]).toBe(false)
    expect(frameRead.axes).toEqual({ x: 0.1, y: -0.2 })
    expect(readGamepadFrame(null).connected).toBe(false)
  })

  it('elige un solo mando estándar y prioriza el que tiene actividad', () => {
    const makePad = (index: number, mapping: string, pressed = false): Gamepad =>
      ({
        connected: true,
        id: `Pad ${index}`,
        index,
        mapping,
        buttons: Array.from({ length: 17 }, (_, buttonIndex) => ({
          pressed: pressed && buttonIndex === GAMEPAD.accept,
          touched: false,
          value: pressed && buttonIndex === GAMEPAD.accept ? 1 : 0
        })),
        axes: [0, 0, 0, 0]
      }) as unknown as Gamepad

    const idle = makePad(0, 'standard')
    const nonStandard = makePad(1, '')
    const active = makePad(2, 'standard', true)

    expect(pickActiveGamepad([nonStandard], null)).toBeNull()
    expect(pickActiveGamepad([idle, nonStandard], null)?.index).toBe(0)
    expect(pickActiveGamepad([idle, active], null)?.index).toBe(2)
    expect(pickActiveGamepad([idle, active], 0)?.index).toBe(2)
    expect(pickActiveGamepad([idle], 9)?.index).toBe(0)
  })
})
