import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { resetFocusMemory } from '../../src/renderer/src/lib/focus'
import type { FakeApi } from './fake-api'

export function renderApp(api: FakeApi): ReturnType<typeof render> {
  resetFocusMemory()
  return render(<App api={api} />)
}

export async function openGame(name = 'Hollow Signal'): Promise<void> {
  const card = await screen.findByRole('button', { name: new RegExp(name) })
  fireEvent.click(card)
  await screen.findByRole('heading', { level: 1, name: new RegExp(name) })
}

export async function openInstall(name = 'Hollow Signal'): Promise<void> {
  await openGame(name)
  const progress = await screen.findByRole('button', { name: 'Ver instalación' })
  fireEvent.click(progress)
  await screen.findByText('Detalles de la operación')
}

export async function openSettings(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Ajustes' }))
  await screen.findByRole('heading', { level: 1, name: 'Ajustes' })
}

export async function openSteam(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Steam/ }))
  await screen.findByRole('heading', { level: 1, name: 'Steam' })
}

export async function openIdentity(): Promise<void> {
  await openGame()
  fireEvent.click(await screen.findByRole('button', { name: 'Elegir identidad' }))
  await screen.findByRole('heading', { level: 1, name: /Identidad de/ })
}

export async function openArtwork(): Promise<void> {
  await openGame()
  fireEvent.click(await screen.findByRole('button', { name: 'Elegir imágenes' }))
  await screen.findByRole('heading', { level: 1, name: /Imágenes de/ })
}

export async function waitForFocus(name: string | RegExp): Promise<void> {
  await waitFor(() => {
    const active = document.activeElement
    expectActiveName(active, name)
  })
}

function expectActiveName(active: Element | null, name: string | RegExp): void {
  const label =
    active?.getAttribute('aria-label') ??
    active?.textContent ??
    active?.getAttribute('data-focus-id') ??
    ''
  if (typeof name === 'string') {
    if (!label.includes(name)) throw new Error(`El foco activo no contiene "${name}": ${label}`)
  } else if (!name.test(label)) {
    throw new Error(`El foco activo no coincide con ${String(name)}: ${label}`)
  }
}
