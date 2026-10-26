export type Screen =
  | { type: 'library' }
  | { type: 'game'; gameId: string }
  | { type: 'install'; gameId: string }
  | { type: 'identity'; gameId: string }
  | { type: 'artwork'; gameId: string }
  | { type: 'steam' }
  | { type: 'settings' }

export interface NavState {
  current: Screen
  history: Screen[]
}

export type NavAction =
  | { type: 'navigate'; screen: Screen }
  | { type: 'replace'; screen: Screen }
  | { type: 'back' }

export function createNavState(initial: Screen = { type: 'library' }): NavState {
  return { current: initial, history: [] }
}

export function screenKey(screen: Screen): string {
  if ('gameId' in screen) return `${screen.type}:${screen.gameId}`
  return screen.type
}

export function screenLabel(screen: Screen): string {
  switch (screen.type) {
    case 'library':
      return 'Biblioteca'
    case 'game':
      return 'Ficha del juego'
    case 'install':
      return 'Instalación'
    case 'identity':
      return 'Identidad'
    case 'artwork':
      return 'Imágenes'
    case 'steam':
      return 'Steam'
    case 'settings':
      return 'Ajustes'
  }
}

export function navReducer(state: NavState, action: NavAction): NavState {
  if (action.type === 'back') {
    if (state.current.type === 'library') return state
    const previous = state.history[state.history.length - 1]
    if (previous) {
      return { current: previous, history: state.history.slice(0, -1) }
    }
    return { current: { type: 'library' }, history: [] }
  }

  if (screenKey(action.screen) === screenKey(state.current)) return state

  if (action.type === 'replace') {
    return { current: action.screen, history: state.history }
  }

  if (action.screen.type === 'library') {
    return { current: action.screen, history: [] }
  }

  return { current: action.screen, history: [...state.history, state.current] }
}
