// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { makeBootstrap, makeGame, makeSnapshot } from './fixtures'
import { openInstall, renderApp } from './render'

afterEach(() => {
  cleanup()
})

describe('Pantalla de instalación', () => {
  it('muestra porcentaje y bytes reales durante la extracción', async () => {
    const game = makeGame({
      install: makeSnapshot('extracting', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        logPath: 'C:\\Logs\\hollow-signal.log',
        startedAt: '2026-10-20T18:31:00.000Z',
        progress: {
          phase: 'Extrayendo el payload del paquete',
          bytesDone: 512,
          bytesTotal: 1024,
          percent: 42,
          indeterminate: false
        }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openInstall()

    expect(screen.getByText('Extrayendo archivos')).toBeTruthy()
    expect(screen.getByTestId('install-percent').textContent).toContain('42')
    expect(screen.getByTestId('install-bytes').textContent).toContain('512 B de 1 KiB')

    const bar = screen.getByRole('progressbar', { name: 'Progreso de la instalación' })
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByRole('button', { name: 'Cancelar instalación' })).toBeTruthy()
    expect(screen.getByText('C:\\Logs\\hollow-signal.log')).toBeTruthy()
  })

  it('durante el setup no muestra porcentaje inventado y no permite cancelar', async () => {
    const game = makeGame({
      install: makeSnapshot('installing', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        logPath: 'C:\\Logs\\hollow-signal.log',
        pid: 4242,
        progress: {
          phase: 'Setup en ejecución. Windows puede mostrar ventanas del instalador.',
          percent: 99,
          bytesDone: 999,
          bytesTotal: 1000,
          indeterminate: true
        }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openInstall()

    expect(screen.getByText('Setup en ejecución')).toBeTruthy()
    expect(screen.queryByTestId('install-percent')).toBeNull()
    expect(screen.getByText('El setup está en ejecución')).toBeTruthy()
    expect(screen.getByText(/no cerrará el proceso por la fuerza/)).toBeTruthy()
    expect(screen.getByText('4242')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancelar instalación' })).toBeNull()
  })

  it('actualiza el progreso desde install:progress y cambia a indeterminado al iniciar el setup', async () => {
    const game = makeGame({
      install: makeSnapshot('validating', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        logPath: 'C:\\Logs\\hollow-signal.log',
        progress: { phase: 'Validando', indeterminate: true }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openInstall()

    act(() => {
      api.emit({
        type: 'install:progress',
        payload: {
          gameId: 'hollow-signal',
          snapshot: makeSnapshot('extracting', {
            installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
            progress: {
              phase: 'Extrayendo el payload del paquete',
              bytesDone: 128,
              bytesTotal: 1024,
              percent: 12.5,
              indeterminate: false
            }
          })
        }
      })
    })

    expect(await screen.findByTestId('install-percent')).toBeTruthy()
    expect(screen.getByTestId('install-percent').textContent).toContain('12,5')

    act(() => {
      api.emit({
        type: 'install:progress',
        payload: {
          gameId: 'hollow-signal',
          snapshot: makeSnapshot('installing', {
            installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
            pid: 777,
            progress: { phase: 'Setup en ejecución', percent: 88, indeterminate: true }
          })
        }
      })
    })

    await waitFor(() => expect(screen.queryByTestId('install-percent')).toBeNull())
    expect(screen.getByText('777')).toBeTruthy()
    expect(screen.getByText('El setup está en ejecución')).toBeTruthy()
  })

  it('cancelar abre confirmación navegable y llama a cancelOperation', async () => {
    const game = makeGame({
      install: makeSnapshot('extracting', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        progress: { phase: 'Extrayendo', indeterminate: true }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openInstall()

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar instalación' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar instalación' })
    expect(dialog).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Sí, cancelar' }))
    await waitFor(() => expect(callsFor(api, 'cancelOperation')).toHaveLength(1))
    expect(callsFor(api, 'cancelOperation')[0]?.args[0]).toBe('hollow-signal')
  })

  it('muestra el error real y los detalles técnicos saneados', async () => {
    const game = makeGame({
      install: makeSnapshot('failed', {
        installDir: 'C:\\Games\\BPSteamFit\\hollow-signal',
        logPath: 'C:\\Logs\\hollow-signal.log',
        error: {
          code: 'INSTALL_VERIFY_FAILED',
          message: 'La verificación encontró archivos ausentes.',
          details: { missingFiles: ['bin/game.exe'], apiKey: 'no-debe-verse' }
        }
      })
    })
    const api = createFakeApi({ bootstrap: makeBootstrap({ games: [game] }) })
    renderApp(api)
    await openInstall()

    expect(screen.getByText('La verificación encontró archivos ausentes.')).toBeTruthy()
    expect(screen.getByText('Reintentar instalación')).toBeTruthy()
    fireEvent.click(screen.getByText('Código y detalles técnicos'))
    expect(screen.getByText('INSTALL_VERIFY_FAILED')).toBeTruthy()
    expect(screen.queryByText(/no-debe-verse/)).toBeNull()
  })
})
