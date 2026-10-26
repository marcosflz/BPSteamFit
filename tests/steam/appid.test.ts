import { describe, expect, it } from 'vitest'
import {
  allocateShortcutAppId,
  computeShortcutAppId,
  computeShortcutAppIdFromFields,
  crc32Ieee,
  formatSteamLaunchId,
  getArtworkFileName,
  getSteamLaunchId,
  isShortcutAppId,
  normalizeArtworkExtension,
  quoteSteamPath,
  toSignedAppId,
  toUnsignedAppId
} from '@core/steam'

describe('CRC32 y AppID de accesos externos', () => {
  it('coincide con el vector estándar CRC32 IEEE', () => {
    expect(crc32Ieee('123456789')).toBe(0xcbf43926)
    expect(crc32Ieee('')).toBe(0)
  })

  it('reproduce el vector citado por steam-notes para Kodi', () => {
    // https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md
    // "\"/usr/bin/kodi\"" + "Kodi" -> 2443196458
    expect(computeShortcutAppId('/usr/bin/kodi', 'Kodi')).toBe(2443196458)
    expect(computeShortcutAppIdFromFields('"/usr/bin/kodi"', 'Kodi')).toBe(2443196458)
    expect(isShortcutAppId(2443196458)).toBe(true)
    expect(toSignedAppId(2443196458)).toBe(-1851770838)
    expect(toUnsignedAppId(-1851770838)).toBe(2443196458)
    expect(formatSteamLaunchId(2443196458)).toBe('10493448884846592000')
    expect(getSteamLaunchId(2443196458)).toBe(10493448884846592000n)
  })

  it('calcula nombres de artwork con el AppID sin signo', () => {
    // https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md
    // https://github.com/epurn/gamehub/blob/main/docs/steam-integration.md
    expect(getArtworkFileName(2443196458, 'portrait')).toBe('2443196458p.png')
    expect(getArtworkFileName(2443196458, 'hero')).toBe('2443196458_hero.png')
    expect(getArtworkFileName(2443196458, 'logo')).toBe('2443196458_logo.png')
    expect(getArtworkFileName(2443196458, 'icon')).toBe('2443196458_icon.png')
    expect(getArtworkFileName(2443196458, 'portrait', '.JPG')).toBe('2443196458p.jpg')
    expect(normalizeArtworkExtension('.JPEG')).toBe('.jpg')
    expect(() => normalizeArtworkExtension('.webp')).toThrowError(/no soportada/)
    expect(() => getArtworkFileName(0, 'portrait')).toThrowError(/AppID 0/)
  })

  it('cotiza rutas de Steam de forma idempotente y rechaza comillas internas', () => {
    expect(quoteSteamPath('C:\\Games\\Hades\\Hades.exe')).toBe('"C:\\Games\\Hades\\Hades.exe"')
    expect(quoteSteamPath('"C:\\Games\\Hades\\Hades.exe"')).toBe('"C:\\Games\\Hades\\Hades.exe"')
    expect(() => quoteSteamPath('C:\\mal"path\\a.exe')).toThrowError(/comillas/)
    expect(() => quoteSteamPath('C:\\mal\u0000path')).toThrowError(/NUL/)
    expect(() => quoteSteamPath('')).toThrowError(/vacía/)
  })

  it('propone un AppID de respaldo determinista y libre si el heredado colisiona', () => {
    const legacy = computeShortcutAppId('C:\\Games\\Hades\\Hades.exe', 'Hades')
    const first = allocateShortcutAppId('C:\\Games\\Hades\\Hades.exe', 'Hades', [legacy])
    const second = allocateShortcutAppId('C:\\Games\\Hades\\Hades.exe', 'Hades', [legacy])
    expect(first.source).toBe('collision-fallback')
    expect(second.appId).toBe(first.appId)
    expect(first.appId).not.toBe(legacy)
    expect(isShortcutAppId(first.appId)).toBe(true)
    const free = allocateShortcutAppId('C:\\Games\\Hades\\Hades.exe', 'Hades', [])
    expect(free).toEqual({ appId: legacy, source: 'legacy-crc' })
  })
})
