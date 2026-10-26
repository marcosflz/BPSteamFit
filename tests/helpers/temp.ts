import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface TempDirectory {
  path: string
  cleanup: () => Promise<void>
}

export async function makeTempDir(prefix = 'bpsfit-test-'): Promise<TempDirectory> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    path: created,
    cleanup: async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(created, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }
  }
}

export async function waitFor<T>(
  action: () => Promise<T | null> | T | null,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let last: T | null = null
  while (Date.now() < deadline) {
    last = await action()
    if (last !== null && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor agotó el tiempo. Último valor: ${JSON.stringify(last)}`)
}
