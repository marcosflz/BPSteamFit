import type { MetadataLanguage, MetadataProvider } from './types'
import { MockMetadataProvider } from './mock-provider'
import { SteamGridDbProvider, type SteamGridDbOptions } from './steamgriddb-provider'

export type MetadataProviderId = 'mock' | 'steamgriddb'

export interface CreateMetadataProviderOptions extends SteamGridDbOptions {
  provider?: MetadataProviderId
  language?: MetadataLanguage
  now?: () => Date
}

/**
 * Fábrica con proveedor mock por defecto. Sin clave, SteamGridDB se construye
 * igualmente pero informa `METADATA_AUTH_REQUIRED`; la app sigue operativa con
 * el proveedor de demostración.
 */
export function createMetadataProvider(
  options: CreateMetadataProviderOptions = {}
): MetadataProvider {
  if (options.provider === 'steamgriddb') {
    return new SteamGridDbProvider(options)
  }
  return new MockMetadataProvider({ language: options.language, now: options.now })
}
