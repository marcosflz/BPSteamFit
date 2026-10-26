import { useEffect, useRef, useState } from 'react'
import {
  createGamepadState,
  gamepadClock,
  pickActiveGamepad,
  readGamepadFrame,
  stepGamepad,
  type GamepadStepState,
  type NavAction
} from '../lib/gamepad'

export interface UseGamepadOptions {
  enabled?: boolean
  /** Intervalo de sondeo; 16 ms ≈ 60 Hz. */
  pollMs?: number
}

/**
 * Única fuente de entrada de mando de la app. Sondea la Gamepad API con el
 * mapeo estándar y emite acciones ya normalizadas.
 *
 * No se registran listeners de teclado aquí. Los eventos connect/disconnect se
 * usan para actualizar el indicador y reiniciar el estado de repetición.
 */
export function useGamepad(
  onAction: (action: NavAction) => void,
  options: UseGamepadOptions = {}
): { connected: boolean } {
  const { enabled = true, pollMs = 16 } = options
  const actionRef = useRef(onAction)
  actionRef.current = onAction
  const [connected, setConnected] = useState(false)
  const connectedRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      connectedRef.current = false
      setConnected(false)
      return
    }

    let disposed = false
    let timer: number | null = null
    let stepState: GamepadStepState = createGamepadState()
    let activeIndex: number | null = null

    const publishConnection = (value: boolean): void => {
      if (disposed || connectedRef.current === value) return
      connectedRef.current = value
      setConnected(value)
    }

    const poll = (): void => {
      if (disposed) return
      const pad = pickActiveGamepad(undefined, activeIndex)
      if (!pad) {
        activeIndex = null
        stepState = createGamepadState()
        publishConnection(false)
        timer = window.setTimeout(poll, pollMs)
        return
      }
      if (pad.index !== activeIndex) {
        // Cambió el mando activo (o es el primero): inicializa sin entregar
        // acciones para no aceptar algo por accidente.
        activeIndex = pad.index
        stepState = createGamepadState()
      }
      const frame = readGamepadFrame(pad)
      const result = stepGamepad(stepState, frame, gamepadClock())
      stepState = result.state
      publishConnection(result.state.connected)

      // Si la ventana no tiene el foco (por ejemplo, durante el reinicio de
      // Steam), se actualiza el estado pero no se entrega la acción.
      const focused = typeof document === 'undefined' || !document.hasFocus || document.hasFocus()
      if (focused) {
        for (const action of result.actions) {
          actionRef.current(action)
        }
      }

      timer = window.setTimeout(poll, pollMs)
    }

    const onDisconnect = (): void => {
      stepState = createGamepadState()
      activeIndex = null
    }
    const onConnect = (): void => {
      // El siguiente sondeo decide si el mando es estándar. No se anuncia un
      // gamepad no compatible (vJoy, joystick genérico) como "mando conectado".
    }

    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    poll()

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [enabled, pollMs])

  return { connected }
}
