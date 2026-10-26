import { useCallback, useState } from 'react'
import { toUiError, type UiError } from '../lib/errors'

export type AsyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: UiError }

export interface AsyncAction {
  busy: boolean
  error: UiError | null
  run: <T>(task: () => Promise<T>) => Promise<AsyncResult<T>>
  clearError: () => void
}

/** Pequeño envoltorio para que ninguna acción deje la interfaz bloqueada. */
export function useAsyncAction(): AsyncAction {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<AsyncResult<T>> => {
    setBusy(true)
    setError(null)
    try {
      const value = await task()
      return { ok: true, value }
    } catch (caught) {
      const uiError = toUiError(caught)
      setError(uiError)
      return { ok: false, error: uiError }
    } finally {
      setBusy(false)
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { busy, error, run, clearError }
}
