// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import {
  makeAccount,
  makeBootstrap,
  makeSteamStatus,
  makeSteamSyncResult
} from './fixtures'
import { openSteam, renderApp } from './render'

afterEach(cleanup)

const pendingChanges = [
  {
    gameId: 'hollow-signal',
    gameName: 'Hollow Signal',
    action: 'add' as const,
    reason: 'Nuevo acceso directo para un juego instalado.'
  }
]

describe('Steam', () => {
  it('muestra cuenta, cambios pendientes y resultado real, y sincroniza con confirmación', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        steam: makeSteamStatus({
          running: true,
          pendingChanges,
          lastResult: makeSteamSyncResult()
        })
      })
    })
    renderApp(api)
    await openSteam()

    await screen.findByRole('button', { name: 'Sincronizar con Steam' })
    expect(callsFor(api, 'getSteamStatus').length).toBeGreaterThan(0)
    expect(screen.getByText('Steam está abierto')).toBeTruthy()
    expect(screen.getByText('Nuevo acceso directo para un juego instalado.')).toBeTruthy()
    expect(screen.getByText('Cambios pendientes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Marco, perfil seleccionado' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar con Steam' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sincronizar con Steam' })
    expect(within(dialog).getByText(/BPSteamFit se cerrará y Steam se reiniciará/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sincronizar ahora' }))

    await waitFor(() => expect(callsFor(api, 'prepareSteamSync')).toHaveLength(1))
    await waitFor(() => expect(callsFor(api, 'startSteamSync')).toHaveLength(1))
    expect(callsFor(api, 'startSteamSync')[0]?.args[0]).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText(/Sincronización programada/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Abrir carpeta de logs/ }))
    await waitFor(() => expect(callsFor(api, 'openLogFolder')).toHaveLength(1))
  })

  it('selecciona otro perfil de Steam mediante selectSteamAccount', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        steam: makeSteamStatus({
          accounts: [
            makeAccount(),
            makeAccount({
              accountId: '76561198000000002',
              steamId64: '76561198000000002',
              personaName: 'Ana',
              isSelected: false,
              shortcutsPath: 'C:\\Steam\\userdata\\76561198000000002\\config\\shortcuts.vdf'
            })
          ]
        })
      })
    })
    renderApp(api)
    await openSteam()
    const ana = await screen.findByRole('button', { name: 'Ana' })
    fireEvent.click(ana)
    await waitFor(() => expect(callsFor(api, 'selectSteamAccount')).toHaveLength(1))
    expect(callsFor(api, 'selectSteamAccount')[0]?.args[0]).toBe('76561198000000002')
  })

  it('no permite sincronizar si Steam no está instalado', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        steam: makeSteamStatus({ installed: false, accounts: [], selectedAccountId: undefined })
      })
    })
    renderApp(api)
    await openSteam()
    const sync = await screen.findByRole('button', { name: 'Sincronizar con Steam' })
    expect((sync as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/No se encontró una instalación de Steam/)).toBeTruthy()
    expect(screen.getByText('Steam no encontrado')).toBeTruthy()
  })
})
