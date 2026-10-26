import type { BpsApi } from '@shared/ipc'

declare global {
  interface Window {
    bps: BpsApi
  }
}

export {}
