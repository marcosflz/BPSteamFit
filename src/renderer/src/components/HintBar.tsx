export function HintBar(props: {
  dialogOpen?: boolean
  tabsEnabled?: boolean
  tabHint?: string
  backEnabled?: boolean
  backLabel?: string
  startLabel?: string
}): React.JSX.Element {
  const dialog = props.dialogOpen ?? false
  const tabsEnabled = !dialog && (props.tabsEnabled ?? false)
  const backEnabled = !dialog && (props.backEnabled ?? true)

  return (
    <footer className="hintbar" aria-label="Controles">
      <div className="hintbar__group">
        <span className="keycap keycap--accent">A</span>
        <span>Seleccionar</span>
      </div>
      <div className={`hintbar__group ${backEnabled ? '' : 'hintbar__group--off'}`}>
        <span className="keycap">B</span>
        <span>{dialog ? 'Cancelar' : (props.backLabel ?? 'Volver')}</span>
      </div>
      <div className={`hintbar__group ${tabsEnabled ? '' : 'hintbar__group--off'}`}>
        <span className="keycap">LB</span>
        <span className="keycap">RB</span>
        <span>{props.tabHint ?? 'Pestañas'}</span>
      </div>
      <div className={`hintbar__group ${dialog ? 'hintbar__group--off' : ''}`}>
        <span className="keycap">Start</span>
        <span>{props.startLabel ?? 'Ajustes'}</span>
      </div>
      <div className="hintbar__keyboard">
        <span className="keycap keycap--small">↑↓←→</span>
        <span className="keycap keycap--small">Enter</span>
        <span className="keycap keycap--small">Esc</span>
        <span>Teclado</span>
      </div>
    </footer>
  )
}
