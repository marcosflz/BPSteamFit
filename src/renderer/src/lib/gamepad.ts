/**
 * Motor de mando puro y testeable.
 *
 * Se usa exclusivamente la Gamepad API del navegador con el mapeo estándar
 * (Xbox / XInput expuesto por Chromium). No se abre ningún dispositivo nativo.
 * La repetición se calcula aquí para que la interfaz no dependa del sistema
 * operativo ni de eventos `keydown` sintéticos.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right'

export type NavAction =
  | NavDirection
  | 'accept'
  | 'back'
  | 'menu'
  | 'tabPrev'
  | 'tabNext'
  | 'aux'
  | 'aux2'

export const GAMEPAD = {
  accept: 0,
  back: 1,
  aux: 2,
  aux2: 3,
  tabPrev: 4,
  tabNext: 5,
  view: 8,
  menu: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15
} as const

export const GAMEPAD_DEADZONE = 0.3
export const GAMEPAD_REPEAT_DELAY_MS = 350
export const GAMEPAD_REPEAT_INTERVAL_MS = 110

export interface GamepadFrame {
  connected: boolean
  /** Estado `pressed` por índice; los índices ausentes equivalen a false. */
  buttons: readonly boolean[]
  axes?: { x: number; y: number }
}

export interface GamepadStepState {
  connected: boolean
  buttons: boolean[]
  direction: NavDirection | null
  nextRepeatAt: number
}

export interface GamepadOptions {
  deadzone?: number
  repeatDelayMs?: number
  repeatIntervalMs?: number
}

export interface GamepadStepResult {
  state: GamepadStepState
  actions: NavAction[]
}

export function createGamepadState(): GamepadStepState {
  return { connected: false, buttons: [], direction: null, nextRepeatAt: 0 }
}

function buttonPressed(frame: GamepadFrame, index: number): boolean {
  return frame.buttons[index] === true
}

function readDirection(frame: GamepadFrame, deadzone: number): NavDirection | null {
  // La cruceta tiene prioridad sobre el stick para evitar dobles pasos y
  // porque es más precisa en menús.
  if (buttonPressed(frame, GAMEPAD.dpadUp)) return 'up'
  if (buttonPressed(frame, GAMEPAD.dpadDown)) return 'down'
  if (buttonPressed(frame, GAMEPAD.dpadLeft)) return 'left'
  if (buttonPressed(frame, GAMEPAD.dpadRight)) return 'right'

  const x = frame.axes?.x ?? 0
  const y = frame.axes?.y ?? 0
  if (Math.abs(x) <= deadzone && Math.abs(y) <= deadzone) return null
  if (Math.abs(x) >= Math.abs(y)) {
    return x > 0 ? 'right' : 'left'
  }
  return y > 0 ? 'down' : 'up'
}

/**
 * Avanza un frame de mando. Devuelve las acciones que deben ejecutarse y el
 * estado para el siguiente frame.
 *
 * - Al conectar un mando no se emiten acciones (evita aceptar algo por accidente
 *   al recuperar el foco).
 * - Los botones de acción se emiten solo en el flanco de subida.
 * - La dirección se repite tras `repeatDelayMs` y luego cada `repeatIntervalMs`.
 * - Los sticks usan una zona muerta de 0.3 y el eje dominante.
 */
export function stepGamepad(
  state: GamepadStepState,
  frame: GamepadFrame,
  now: number,
  options: GamepadOptions = {}
): GamepadStepResult {
  const deadzone = options.deadzone ?? GAMEPAD_DEADZONE
  const repeatDelay = options.repeatDelayMs ?? GAMEPAD_REPEAT_DELAY_MS
  const repeatInterval = options.repeatIntervalMs ?? GAMEPAD_REPEAT_INTERVAL_MS

  if (!frame.connected) {
    if (!state.connected) return { state, actions: [] }
    return { state: createGamepadState(), actions: [] }
  }

  if (!state.connected) {
    return {
      state: {
        connected: true,
        buttons: frame.buttons.map((pressed) => pressed === true),
        direction: null,
        nextRepeatAt: 0
      },
      actions: []
    }
  }

  const actions: NavAction[] = []
  const wasPressed = (index: number): boolean => state.buttons[index] === true
  const rising = (index: number): boolean =>
    buttonPressed(frame, index) && !wasPressed(index)

  if (rising(GAMEPAD.accept)) actions.push('accept')
  if (rising(GAMEPAD.back) || rising(GAMEPAD.view)) actions.push('back')
  if (rising(GAMEPAD.tabPrev)) actions.push('tabPrev')
  if (rising(GAMEPAD.tabNext)) actions.push('tabNext')
  if (rising(GAMEPAD.menu)) actions.push('menu')
  if (rising(GAMEPAD.aux)) actions.push('aux')
  if (rising(GAMEPAD.aux2)) actions.push('aux2')

  const direction = readDirection(frame, deadzone)
  let nextDirection = state.direction
  let nextRepeatAt = state.nextRepeatAt

  if (direction) {
    if (state.direction !== direction) {
      actions.push(direction)
      nextDirection = direction
      nextRepeatAt = now + repeatDelay
    } else if (now >= state.nextRepeatAt) {
      actions.push(direction)
      nextRepeatAt = now + repeatInterval
    }
  } else {
    nextDirection = null
    nextRepeatAt = 0
  }

  return {
    state: {
      connected: true,
      buttons: frame.buttons.map((pressed) => pressed === true),
      direction: nextDirection,
      nextRepeatAt
    },
    actions
  }
}

/** Lee un `Gamepad` real (o un doble de test) sin lanzar si faltan botones. */
export function readGamepadFrame(pad: Gamepad | null | undefined): GamepadFrame {
  if (!pad || !pad.connected) return { connected: false, buttons: [], axes: { x: 0, y: 0 } }
  const buttons: boolean[] = []
  for (let index = 0; index < Math.max(pad.buttons.length, 16); index += 1) {
    const button = pad.buttons[index]
    buttons[index] = Boolean(button && (button.pressed || button.value > 0.5))
  }
  return {
    connected: true,
    buttons,
    axes: {
      x: typeof pad.axes[0] === 'number' ? pad.axes[0] : 0,
      y: typeof pad.axes[1] === 'number' ? pad.axes[1] : 0
    }
  }
}

export function isDirectionAction(action: NavAction): action is NavDirection {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right'
}

/**
 * Selecciona un único mando compatible. Se exige `mapping === 'standard'`
 * para no interpretar dispositivos vJoy/joysticks genéricos con otro orden de
 * botones. Si hay varios, prioriza el que tiene actividad y, si no, el último
 * usado. Nunca combina dos mandos en el mismo frame.
 */
export function pickActiveGamepad(
  pads?: readonly (Gamepad | null)[],
  preferredIndex?: number | null
): Gamepad | null {
  let available: readonly (Gamepad | null)[]
  if (pads) {
    available = pads
  } else {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null
    try {
      available = navigator.getGamepads()
    } catch {
      return null
    }
  }
  const compatible = available.filter(
    (pad): pad is Gamepad =>
      Boolean(
        pad?.connected &&
          pad.mapping === 'standard' &&
          !/vjoy|virtual joystick/i.test(pad.id)
      )
  )
  if (compatible.length === 0) return null

  const active = compatible.find((pad) => {
    if (pad.buttons.some((button) => button && (button.pressed || button.value > 0.5))) return true
    return pad.axes.some((axis) => Math.abs(axis) > 0.5)
  })
  if (active) return active
  if (preferredIndex !== undefined && preferredIndex !== null) {
    const preferred = compatible.find((pad) => pad.index === preferredIndex)
    if (preferred) return preferred
  }
  return compatible[0] ?? null
}

export function gamepadClock(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}
