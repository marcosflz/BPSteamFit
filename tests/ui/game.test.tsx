// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { GameMetadata } from '@shared/domain'
import { createFakeApi, callsFor } from './fake-api'
import {
  makeArtwork,
  makeBootstrap,
  makeCandidate,
  makeGame,
  makeIdentity,
  makeSnapshot,
  TEST_NOW
} from './fixtures'
import { openGame, renderApp } from './render'

afterEach(cleanup)

const metadata: GameMetadata = {
  title: 'Hollow Signal',
  shortDescription: 'Una señal en la oscuridad.',
  description: 'Una aventura breve sobre escuchar lo que no está.',
  developers: ['Estudio Faro'],
  publishers: ['Editorial Norte'],
  releaseDate: '2025-03-01',
  releaseYear: 2025,
  genres: ['Aventura', 'Misterio'],
  gameModes: ['Un jugador'],
  language: 'es',
  provider: 'mock',
  providerId: 'hollow-signal',
  fetchedAt: TEST_NOW,
  isMock: true
}

describe('Ficha del juego', () => {
  it('muestra metadatos de demostración y ejecuta acciones reales de la API', async () => {
    const game = makeGame({
      metadata,
      identity: makeIdentity('confirmed', [makeCandidate()], {
        provider: 'mock',
        providerId: 'hollow-signal',
        title: 'Hollow Signal',
        decidedBy: 'user'
      }),
      artwork: {
        portrait: makeArtwork({ id: 'portrait-1' }),
        hero: makeArtwork({
          id: 'hero-1',
          kind: 'hero',
          previewUrl: 'bps-media://artwork/hero-1'
        })
      },
      install: makeSnapshot('installed', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        logPath: 'C:\\Logs\\hollow-signal.log',
        verification: {
          ok: true,
          checkedAt: TEST_NOW,
          missingFiles: [],
          missingDirectories: []
        }
      }),
      steam: { enabled: true, displayName: 'Hollow Signal', tags: ['BPSteamFit'], syncState: 'synced' }
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openGame('Hollow Signal')

    expect(screen.getAllByText('Datos de demostración').length).toBeGreaterThan(0)
    expect(screen.getByText('Una aventura breve sobre escuchar lo que no está.')).toBeTruthy()
    expect(screen.getByText('Estudio Faro')).toBeTruthy()
    expect(screen.getByText('Editorial Norte')).toBeTruthy()
    expect(screen.getByText('Aventura, Misterio')).toBeTruthy()
    expect(screen.getByText('v1.0.0')).toBeTruthy()
    expect(screen.getByText('Demostración')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Jugar' }))
    await waitFor(() => expect(callsFor(api, 'launchGame')).toHaveLength(1))
    expect(callsFor(api, 'launchGame')[0]?.args[0]).toBe('hollow-signal')

    fireEvent.click(screen.getByRole('button', { name: 'Comprobar instalación' }))
    await waitFor(() => expect(callsFor(api, 'revalidateInstall')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Abrir carpeta' }))
    await waitFor(() => expect(callsFor(api, 'openPath')).toHaveLength(1))
    expect(callsFor(api, 'openPath')[0]?.args).toEqual([
      'C:\\Games\\BPSteamFit\\hollow-signal',
      'install-dir'
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar con Steam' }))
    await screen.findByRole('heading', { level: 1, name: 'Steam' })
  })

  it('avisa de elevación y problemas del paquete sin inventar metadatos', async () => {
    const game = makeGame({
      packageAvailable: true,
      packageProblem: 'El hash del paquete no coincide con el último escaneo.',
      requiresElevation: true,
      install: makeSnapshot('failed', {
        error: {
          code: 'INSTALL_ELEVATION_REQUIRED',
          message: 'Windows no permite ejecutar el setup sin elevación.'
        }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openGame('Hollow Signal')

    expect(screen.getByText('Este paquete requiere elevación')).toBeTruthy()
    expect(screen.getByText('Requiere UAC')).toBeTruthy()
    expect(screen.getByText('Problema con el paquete')).toBeTruthy()
    expect(screen.getByText('El hash del paquete no coincide con el último escaneo.')).toBeTruthy()
    expect(screen.getByText('No hay metadatos asociados todavía.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Instalar' })).toBeTruthy()
  })

  it('permite elegir un destino de instalación distinto antes de confirmar', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openGame('Hollow Signal')
    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }))
    const dialog = await screen.findByRole('dialog', { name: /Instalar Hollow Signal/ })

    fireEvent.click(screen.getByRole('button', { name: 'Elegir otra carpeta…' }))
    await waitFor(() => expect(callsFor(api, 'chooseInstallFolder')).toHaveLength(1))
    expect(await screen.findByText('C:\\Games\\Custom\\HollowSignal')).toBeTruthy()
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Instalar ahora' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Instalar ahora' }))
    await waitFor(() => expect(callsFor(api, 'startInstall')).toHaveLength(1))
    expect(callsFor(api, 'startInstall')[0]?.args[0]).toEqual({
      gameId: 'hollow-signal',
      installDir: 'C:\\Games\\Custom\\HollowSignal'
    })
  })
})
