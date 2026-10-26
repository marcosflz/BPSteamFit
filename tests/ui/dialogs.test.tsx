// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { openGame, renderApp, waitForFocus } from './render'
import { resetFocusMemory } from '../../src/renderer/src/lib/focus'
import { Modal } from '../../src/renderer/src/components/Modal'

afterEach(() => {
  cleanup()
  resetFocusMemory()
  document.body.innerHTML = ''
})

describe('diálogos con foco atrapado', () => {
  it('atrapa Tab, enfoca el control inicial y restaura el foco al cerrar', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" data-focusable onClick={() => setOpen(true)}>
            Abrir diálogo
          </button>
          {open ? (
            <Modal title="Diálogo de prueba" onClose={() => setOpen(false)}>
              <button type="button" data-focusable data-autofocus>
                Uno
              </button>
              <button type="button" data-focusable>
                Dos
              </button>
            </Modal>
          ) : null}
        </div>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Abrir diálogo' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Diálogo de prueba' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Uno'))

    const dos = screen.getByRole('button', { name: 'Dos' })
    dos.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(dos)

    // Un intento de enfocar el fondo vuelve al diálogo.
    const outside = document.createElement('button')
    outside.textContent = 'Fuera'
    document.body.appendChild(outside)
    outside.focus()
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('permite confirmar la instalación con teclado y llama a startInstall', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openGame('Hollow Signal')
    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))

    const dialog = await screen.findByRole('dialog', { name: /Instalar Hollow Signal/ })
    expect(dialog).toBeTruthy()
    await waitForFocus('Cancelar')

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Instalar ahora'))
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => expect(callsFor(api, 'startInstall')).toHaveLength(1))
    expect(callsFor(api, 'startInstall')[0]?.args[0]).toEqual({
      gameId: 'hollow-signal',
      installDir: undefined
    })
    await screen.findByText('Detalles de la operación')
    expect(screen.getByText('Validando el paquete')).toBeTruthy()
  })

  it('cierra el diálogo con Escape sin ejecutar la acción', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openGame('Hollow Signal')
    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))
    await screen.findByRole('dialog', { name: /Instalar Hollow Signal/ })

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsFor(api, 'startInstall')).toHaveLength(0)
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('Instalar')
    )
  })
})
