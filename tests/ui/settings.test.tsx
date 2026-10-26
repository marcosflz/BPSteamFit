// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { createFakeApi, callsFor } from './fake-api'
import { makeBootstrap, makeProviders, makeSettings } from './fixtures'
import { openSettings, renderApp } from './render'

afterEach(cleanup)

describe('Ajustes', () => {
  it('muestra rutas, proveedor y ayuda, y llama a la API al cambiarlos', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        settings: makeSettings({ metadataProvider: 'mock', referToMetadataInSpanish: true }),
        providers: makeProviders({
          steamgriddb: {
            configured: true,
            available: true,
            description: 'Metadatos y arte de SteamGridDB.',
            attribution: 'Datos de SteamGridDB.'
          }
        })
      })
    })
    renderApp(api)
    await openSettings()

    expect(screen.getByText('C:\\Users\\Player\\BPSteamFit\\Packages')).toBeTruthy()
    expect(screen.getByText('C:\\Games\\BPSteamFit')).toBeTruthy()
    expect(screen.getAllByText(/Steam Input/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Añadir carpeta' }))
    await waitFor(() => expect(callsFor(api, 'addPackageFolder')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Elegir raíz' }))
    await waitFor(() => expect(callsFor(api, 'chooseInstallationRoot')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: /^SteamGridDB/ }))
    await waitFor(() => expect(callsFor(api, 'updateSettings')).toHaveLength(1))
    expect(callsFor(api, 'updateSettings')[0]?.args[0]).toEqual({ metadataProvider: 'steamgriddb' })

    fireEvent.click(screen.getByRole('button', { name: /Fichas en español/ }))
    await waitFor(() => expect(callsFor(api, 'updateSettings')).toHaveLength(2))
    expect(callsFor(api, 'updateSettings')[1]?.args[0]).toEqual({ referToMetadataInSpanish: false })
  })

  it('configura la clave con un campo password, la envía a la API y no la muestra', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Configurar clave' }))
    const dialog = await screen.findByRole('dialog', { name: 'Clave de SteamGridDB' })
    const input = within(dialog).getByLabelText('Clave de API') as HTMLInputElement
    expect(input.type).toBe('password')

    fireEvent.change(input, { target: { value: 'clave-super-secreta' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar clave' }))

    await waitFor(() => expect(callsFor(api, 'setSteamGridDbKey')).toHaveLength(1))
    expect(callsFor(api, 'setSteamGridDbKey')[0]?.args[0]).toBe('clave-super-secreta')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.textContent).not.toContain('clave-super-secreta')
    expect(screen.getByText('Clave configurada')).toBeTruthy()
  })

  it('borra la clave solo tras confirmar y llama a clearSteamGridDbKey', async () => {
    const api = createFakeApi({
      bootstrap: makeBootstrap({
        providers: makeProviders({
          steamgriddb: {
            configured: true,
            available: true,
            description: 'Metadatos y arte de SteamGridDB.',
            attribution: 'Datos de SteamGridDB.'
          }
        })
      })
    })
    renderApp(api)
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Borrar clave' }))
    const dialog = await screen.findByRole('dialog', { name: 'Borrar clave de SteamGridDB' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar clave' }))
    await waitFor(() => expect(callsFor(api, 'clearSteamGridDbKey')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getAllByText('Sin clave').length).toBeGreaterThan(0)
  })

  it('confirma la salida de la aplicación con la API real', async () => {
    const api = createFakeApi()
    renderApp(api)
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Salir de la aplicación' }))
    const dialog = await screen.findByRole('dialog', { name: 'Salir de BPSteamFit' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, salir' }))
    await waitFor(() => expect(callsFor(api, 'quit')).toHaveLength(1))
  })
})
