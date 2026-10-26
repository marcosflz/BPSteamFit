// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { makeArtwork, makeBootstrap, makeGame, makeSnapshot, makeSteamStatus } from './fixtures'
import { openGame, renderApp } from './render'

afterEach(cleanup)

describe('Biblioteca', () => {
  it('muestra juegos, portada local, placeholders y estados reales', async () => {
    const games = [
      makeGame({
        id: 'hollow-signal',
        name: 'Hollow Signal',
        artwork: {
          portrait: makeArtwork({ id: 'portrait-hollow', previewUrl: 'bps-media://artwork/hollow' })
        }
      }),
      makeGame({
        id: 'lost-package',
        name: 'Lost Package',
        packageAvailable: false,
        packageProblem: 'El archivo .game ya no está en la carpeta.',
        install: makeSnapshot('failed', {
          error: { code: 'PACKAGE_UNAVAILABLE', message: 'No se puede instalar.' }
        }),
        steam: { enabled: true, displayName: 'Lost Package', tags: [], syncState: 'pending' }
      }),
      makeGame({
        id: 'installed-game',
        name: 'Installed Game',
        install: makeSnapshot('installed', { installDir: 'C:\\Games\\BPSteamFit\\installed-game' })
      })
    ]
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        games,
        steam: makeSteamStatus({
          pendingChanges: [
            {
              gameId: 'lost-package',
              gameName: 'Lost Package',
              action: 'add',
              reason: 'Nuevo acceso'
            }
          ]
        })
      })
    })

    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })

    expect(screen.getByRole('button', { name: /Hollow Signal/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Lost Package/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Installed Game/ })).toBeTruthy()

    const localImage = document.querySelector('img[src="bps-media://artwork/hollow"]')
    expect(localImage).not.toBeNull()
    expect(localImage?.getAttribute('src')).not.toMatch(/^https?:/)

    // Lost Package e Installed Game no tienen artwork: placeholders locales.
    expect(screen.getAllByTestId('artwork-placeholder')).toHaveLength(2)

    expect(screen.getByText('Paquete ausente')).toBeTruthy()
    expect(screen.getByText('Pendiente Steam')).toBeTruthy()
    expect(screen.getByText('Fallo de instalación')).toBeTruthy()
    expect(screen.getAllByText('Disponible').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Instalado').length).toBeGreaterThan(0)
    expect(screen.getByText('1 paquete ausente')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Steam, 1 cambio pendiente' })).toBeTruthy()
    expect(screen.getByText('Sin mando · teclado')).toBeTruthy()
  })

  it('ofrece onboarding real cuando no hay juegos y llama a la API', async () => {
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [] }) })
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'Tu salón está esperando' })
    expect(screen.getByText(/No descarga juegos ni necesita una cuenta/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Añadir carpeta de paquetes' }))
    await waitFor(() => expect(callsFor(api, 'addPackageFolder')).toHaveLength(1))
    await waitFor(() => expect(callsFor(api, 'rescanPackages').length).toBeGreaterThan(0))
  })

  it('filtra la biblioteca sin perder los juegos del catálogo', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        games: [
          makeGame({ id: 'one', name: 'Uno', install: makeSnapshot('installed') }),
          makeGame({ id: 'two', name: 'Dos', steam: { enabled: true, displayName: 'Dos', tags: [], syncState: 'pending' } })
        ]
      })
    })
    renderApp(api)
    await screen.findByRole('heading', { level: 1, name: 'El salón' })

    fireEvent.click(screen.getByRole('tab', { name: /Instalados/ }))
    expect(screen.getByRole('button', { name: /Uno/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Dos/ })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Steam pendiente/ }))
    expect(screen.getByRole('button', { name: /^Dos/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Uno/ })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Todo el salón/ }))
    expect(screen.getByRole('button', { name: /^Uno/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Dos/ })).toBeTruthy()
  })

  it('abre la ficha del juego al activar una carátula', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openGame('Hollow Signal')
    expect(screen.getByRole('button', { name: 'Instalar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Elegir identidad' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Elegir imágenes' })).toBeTruthy()
  })
})
