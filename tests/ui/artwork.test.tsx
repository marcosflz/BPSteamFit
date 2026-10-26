// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { makeArtwork, makeBootstrap, makeGalleryItem, makeGame } from './fixtures'
import { openArtwork, renderApp } from './render'

afterEach(cleanup)

const portraitGallery = [
  makeGalleryItem({
    id: 'portrait-provider',
    kind: 'portrait',
    provider: 'SteamGridDB',
    source: 'provider',
    previewUrl: 'bps-media://artwork/portrait-provider',
    width: 600,
    height: 900
  }),
  makeGalleryItem({
    id: 'portrait-manual',
    kind: 'portrait',
    provider: 'Archivo local',
    source: 'manual',
    previewUrl: 'bps-media://artwork/portrait-manual',
    width: 700,
    height: 1000
  })
]

const heroGallery = [
  makeGalleryItem({
    id: 'hero-provider',
    kind: 'hero',
    provider: 'SteamGridDB',
    previewUrl: 'bps-media://artwork/hero-provider',
    width: 1920,
    height: 620
  })
]

function makeArtworkApi(): ReturnType<typeof createFakeApi> {
  const game = makeGame({
    artwork: {
      portrait: makeArtwork({
        id: 'portrait-provider',
        source: 'provider',
        previewUrl: 'bps-media://artwork/portrait-provider'
      })
    }
  })
  return createFakeApi({
    bootstrap: makeBootstrap({ games: [game] }),
    galleries: { portrait: portraitGallery, hero: heroGallery }
  })
}

describe('Galería de artwork', () => {
  it('carga pestañas reales y llama a getArtworkGallery al cambiar de categoría', async () => {
    const api = makeArtworkApi()
    renderApp(api)
    await openArtwork()

    await screen.findByRole('button', { name: /Portada de SteamGridDB, 600×900/ })
    expect(callsFor(api, 'getArtworkGallery').some((call) => call.args[1] === 'portrait')).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: 'Fondo' }))
    await waitFor(() =>
      expect(callsFor(api, 'getArtworkGallery').some((call) => call.args[1] === 'hero')).toBe(true)
    )
    expect(await screen.findByRole('button', { name: /Fondo de SteamGridDB, 1920×620/ })).toBeTruthy()
  })

  it('selecciona una imagen con selectArtwork y mantiene la elección manual', async () => {
    const api = makeArtworkApi()
    renderApp(api)
    await openArtwork()

    fireEvent.click(await screen.findByRole('button', { name: /Portada de Archivo local, 700×1000/ }))
    await waitFor(() => expect(callsFor(api, 'selectArtwork')).toHaveLength(1))
    expect(callsFor(api, 'selectArtwork')[0]?.args).toEqual([
      'hollow-signal',
      'portrait',
      'portrait-manual'
    ])

    const selected = await screen.findByRole('button', {
      name: /Portada de Archivo local, 700×1000, importada, seleccionada/
    })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/Archivo o elección manual/)).toBeTruthy()
    expect(screen.getByText('Elegida')).toBeTruthy()
  })

  it('restaura la selección automática y solicita la galería de nuevo', async () => {
    const api = makeArtworkApi()
    renderApp(api)
    await openArtwork()
    await screen.findByRole('button', { name: /Portada de SteamGridDB/ })

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar automático' }))
    await waitFor(() => expect(callsFor(api, 'resetArtwork')).toHaveLength(1))
    expect(callsFor(api, 'resetArtwork')[0]?.args).toEqual(['hollow-signal', 'portrait'])
  })

  it('importa un archivo local mediante el diálogo del sistema', async () => {
    const api = makeArtworkApi()
    renderApp(api)
    await openArtwork()
    await screen.findByRole('button', { name: /Portada de SteamGridDB/ })

    fireEvent.click(screen.getByRole('button', { name: 'Importar archivo' }))
    await waitFor(() => expect(callsFor(api, 'importLocalArtwork')).toHaveLength(1))
    expect(callsFor(api, 'importLocalArtwork')[0]?.args).toEqual(['hollow-signal', 'portrait'])
  })

  it('muestra un placeholder local cuando no hay artwork', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        games: [makeGame()]
      }),
      galleries: { portrait: [] }
    })
    renderApp(api)
    await openArtwork()
    await waitFor(() => expect(screen.getAllByTestId('artwork-placeholder').length).toBeGreaterThan(0))
    expect(screen.getByText('No hay imágenes disponibles en «Portada».')).toBeTruthy()
  })
})
