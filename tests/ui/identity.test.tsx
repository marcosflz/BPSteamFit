// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { makeBootstrap, makeCandidate, makeGame, makeIdentity } from './fixtures'
import { openIdentity, renderApp } from './render'

afterEach(cleanup)

const candidates = [
  makeCandidate({ key: 'mock:1', provider: 'mock', providerId: '1', title: 'Hollow Signal', releaseYear: 2025 }),
  makeCandidate({
    key: 'gog:2',
    provider: 'gog',
    providerId: '2',
    title: 'Hollow Signal Remaster',
    releaseYear: 2026,
    verified: false
  })
]

describe('Identidad y metadatos', () => {
  it('marca la ambigüedad y no preselecciona visualmente un candidato', async () => {
    const game = makeGame({
      identity: makeIdentity('ambiguous', candidates, {
        message: 'Coincidencias múltiples para el título del paquete.'
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openIdentity()

    expect(screen.getByText('Ambigüedad sin resolver')).toBeTruthy()
    expect(screen.getByText(/La búsqueda devolvió 2 títulos posibles/)).toBeTruthy()
    expect(screen.queryByText('Elegido')).toBeNull()

    const first = screen.getByRole('button', { name: /Hollow Signal, 2025, mock/ })
    const second = screen.getByRole('button', { name: /Hollow Signal Remaster, 2026, gog/ })
    expect(first.getAttribute('aria-pressed')).toBe('false')
    expect(second.getAttribute('aria-pressed')).toBe('false')
  })

  it('confirma el candidato elegido con la API y lo marca como elegido', async () => {
    const game = makeGame({ identity: makeIdentity('ambiguous', candidates) })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openIdentity()

    fireEvent.click(screen.getByRole('button', { name: /Hollow Signal Remaster, 2026, gog/ }))
    await waitFor(() => expect(callsFor(api, 'chooseIdentity')).toHaveLength(1))
    expect(callsFor(api, 'chooseIdentity')[0]?.args).toEqual(['hollow-signal', 'gog:2'])
    expect(await screen.findByText('Elegido')).toBeTruthy()
    const chosen = screen.getByRole('button', { name: /Hollow Signal Remaster, 2026, gog, elegido/ })
    expect(chosen.getAttribute('aria-pressed')).toBe('true')
  })

  it('busca de nuevo con teclado en pantalla y envía el texto a searchIdentity', async () => {
    const game = makeGame({ identity: makeIdentity('ambiguous', candidates) })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openIdentity()

    fireEvent.click(screen.getByRole('button', { name: 'Buscar otro título' }))
    await screen.findByRole('heading', { name: 'Buscar otro título' })
    expect(await screen.findByLabelText('Título a buscar')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tecla Z' }))
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    await waitFor(() => expect(callsFor(api, 'searchIdentity')).toHaveLength(1))
    expect(callsFor(api, 'searchIdentity')[0]?.args[0]).toBe('hollow-signal')
    expect(String(callsFor(api, 'searchIdentity')[0]?.args[1])).toContain('Z')
  })

  it('permite escribir con teclado físico en el campo de búsqueda', async () => {
    const game = makeGame({ identity: makeIdentity('ambiguous', candidates) })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openIdentity()

    fireEvent.click(screen.getByRole('button', { name: 'Buscar otro título' }))
    const input = await screen.findByLabelText('Título a buscar')
    fireEvent.change(input, { target: { value: 'Nueva Busqueda' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    await waitFor(() => expect(callsFor(api, 'searchIdentity')).toHaveLength(1))
    expect(callsFor(api, 'searchIdentity')[0]?.args[1]).toBe('Nueva Busqueda')
  })

  it('continuar sin metadatos pide confirmación y llama a clearIdentity', async () => {
    const game = makeGame({
      identity: makeIdentity('confirmed', candidates, {
        provider: 'mock',
        providerId: '1',
        title: 'Hollow Signal'
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openIdentity()

    fireEvent.click(screen.getByRole('button', { name: 'Continuar sin metadatos' }))
    await screen.findByRole('dialog', { name: 'Quitar identidad y metadatos' })
    fireEvent.click(screen.getByRole('button', { name: 'Quitar metadatos' }))

    await waitFor(() => expect(callsFor(api, 'clearIdentity')).toHaveLength(1))
    expect(callsFor(api, 'clearIdentity')[0]?.args[0]).toBe('hollow-signal')
  })
})
