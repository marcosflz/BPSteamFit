import { useEffect, useRef } from 'react'
import { KeyboardIcon, SearchIcon } from './icons'

const ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'] as const

export function OnScreenKeyboard(props: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  submitLabel?: string
  busy?: boolean
  onClose?: () => void
  ariaLabel?: string
}): React.JSX.Element {
  const firstKeyRef = useRef<HTMLButtonElement>(null)
  const maxLength = 120

  useEffect(() => {
    firstKeyRef.current?.focus()
  }, [])

  const append = (char: string): void => {
    if (props.value.length >= maxLength) return
    props.onChange(props.value + char)
  }
  const removeLast = (): void => {
    props.onChange(Array.from(props.value).slice(0, -1).join(''))
  }

  return (
    <div className="osk" aria-label="Teclado en pantalla">
      <form
        className="osk__search"
        onSubmit={(event) => {
          event.preventDefault()
          if (props.value.trim() && !props.busy) props.onSubmit()
        }}
      >
        <SearchIcon className="osk__search-icon" />
        <input
          className="text-input"
          type="text"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value.slice(0, maxLength))}
          placeholder="Título, año o edición"
          aria-label={props.ariaLabel ?? 'Texto de búsqueda'}
          autoComplete="off"
          spellCheck={false}
          data-focusable
          data-focus-id="osk-input"
        />
        <button
          type="submit"
          className="btn btn--primary btn--small"
          disabled={!props.value.trim() || props.busy}
          data-focusable
          data-focus-id="osk-submit"
        >
          {props.busy ? 'Buscando…' : (props.submitLabel ?? 'Buscar')}
        </button>
      </form>

      <div className="osk__keys" role="group" aria-label="Teclas">
        {ROWS.map((row, rowIndex) => (
          <div className="osk__row" key={row}>
            {Array.from(row).map((char, charIndex) => (
              <button
                key={char}
                ref={rowIndex === 0 && charIndex === 0 ? firstKeyRef : undefined}
                type="button"
                className="osk__key"
                data-focusable
                data-focus-id={`osk-${char}`}
                aria-label={`Tecla ${char}`}
                onClick={() => append(char)}
              >
                {char}
              </button>
            ))}
          </div>
        ))}
        <div className="osk__row osk__row--actions">
          <button
            type="button"
            className="osk__key osk__key--wide"
            data-focusable
            data-focus-id="osk-space"
            onClick={() => append(' ')}
            aria-label="Espacio"
          >
            espacio
          </button>
          <button
            type="button"
            className="osk__key osk__key--wide"
            data-focusable
            data-focus-id="osk-backspace"
            onClick={removeLast}
            aria-label="Borrar último carácter"
          >
            borrar
          </button>
          <button
            type="button"
            className="osk__key osk__key--wide"
            data-focusable
            data-focus-id="osk-clear"
            onClick={() => props.onChange('')}
            aria-label="Limpiar búsqueda"
          >
            limpiar
          </button>
          {props.onClose ? (
            <button
              type="button"
              className="osk__key osk__key--wide"
              data-focusable
              data-focus-id="osk-close"
              onClick={props.onClose}
            >
              cerrar teclado
            </button>
          ) : null}
        </div>
      </div>

      <p className="osk__hint">
        <KeyboardIcon width={18} height={18} /> Teclado físico: pulsa Tab hasta el campo y escribe.
        Con mando, B sale del campo o cierra el teclado.
      </p>
    </div>
  )
}
