import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import type { NavAction } from '../lib/gamepad'

export interface ScreenControls {
  /** Devuelve true si la pantalla consumió la acción (por ejemplo, LB/RB). */
  onAction?: (action: NavAction) => boolean | void
  /** El botón B/Escape vuelve dentro de la pantalla (cerrar teclado, etc.). */
  onBack?: () => void
}

export type RegisterScreenControls = (controls: ScreenControls) => () => void

export const ScreenControlsContext = createContext<RegisterScreenControls | null>(null)

export function ScreenControlsProvider(props: {
  register: RegisterScreenControls
  children: ReactNode
}) {
  return (
    <ScreenControlsContext.Provider value={props.register}>
      {props.children}
    </ScreenControlsContext.Provider>
  )
}

/**
 * Registra los controles de la pantalla montada. El registro usa un wrapper
 * estable para no re-registrar en cada render y el desregistro comprueba que
 * sigue siendo el propietario (evita borrar la pantalla nueva al navegar).
 */
export function useScreenControls(controls: ScreenControls): void {
  const register = useContext(ScreenControlsContext)
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  useEffect(() => {
    if (!register) return
    const wrapper: ScreenControls = {
      onAction: (action) => controlsRef.current.onAction?.(action),
      onBack: () => controlsRef.current.onBack?.()
    }
    return register(wrapper)
  }, [register])
}
