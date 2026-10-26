// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createFakeApi } from './fake-api'
import { makeBootstrap, makeGame } from './fixtures'
import { renderApp } from './render'

afterEach(cleanup)

function twoGamesApi(): ReturnType<typeof createFakeApi> {
  return createFakeApi({
    bootstrap: makeBootstrap({
      games: [
        makeGame({ id: 'one', name: 'Primer Juego' }),
        makeGame({ id: 'two', name: 'Segundo Juego' })
      ]
    })
  })
}

describe('Navegación de la aplicación con teclado', () => {
  it('enfoca la primera carátula y permite abrir la ficha con Enter', async () => {
    const api = twoGamesApi()
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })

    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-one')
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    await screen.findByRole('heading', { level: 1, name: 'Primer Juego' })
  })

  it('mueve el foco con las flechas y respeta los límites de la cuadrícula', async () => {
    const api = twoGamesApi()
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-one')
    )

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-two')

    // El siguiente control en el DOM es el final de la pantalla; no se envuelve
    // a la primera tarjeta.
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-focus-id')).not.toBe('game-one')
  })

  it('restaura el foco de la carátula al volver desde la ficha', async () => {
    const api = twoGamesApi()
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-one')
    )

    const second = screen.getByRole('button', { name: /Segundo Juego/ })
    second.focus()
    expect(document.activeElement).toBe(second)
    fireEvent.click(second)
    await screen.findByRole('heading', { level: 1, name: 'Segundo Juego' })

    fireEvent.keyDown(window, { key: 'Escape' })
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-focus-id')).toBe('game-two')
    )
  })

  it('usa el botón B del mapeo como volver en la ficha', async () => {
    const api = twoGamesApi()
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    fireEvent.keyDown(window, { key: 'Enter' })
    await screen.findByRole('heading', { level: 1, name: 'Primer Juego' })

    // Escape es el equivalente de teclado del botón B; la ruta de mando emite
    // la misma acción 'back' (ver tests de gamepad).
    fireEvent.keyDown(window, { key: 'Escape' })
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
  })

  it('se suscribe a los eventos del proceso principal y limpia la suscripción', async () => {
    const api = twoGamesApi()
    const view = renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })
    expect(api.listenerCount()).toBe(1)
    view.unmount()
    expect(api.listenerCount()).toBe(0)
  })
})
