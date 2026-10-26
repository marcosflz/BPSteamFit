import { describe, expect, it } from 'vitest'
import { checkRelativePath, isPathInside, slugifyGameId, validateLocalAbsolutePath } from '@shared/safe-path'

describe('rutas seguras', () => {
  it('acepta rutas relativas con Unicode y espacios', () => {
    const result = checkRelativePath('payload/juego con ñ/café.exe')
    expect(result).toEqual({ ok: true, value: 'payload/juego con ñ/café.exe' })
  })

  it.each([
    '../evil.exe',
    'payload/../../evil.exe',
    '/absolute.exe',
    '\\absolute.exe',
    '//server/share/file.exe',
    'C:/Windows/System32/calc.exe',
    '\\\\?\\C:\\Windows\\win.ini',
    'payload\\setup.exe',
    'payload//setup.exe',
    'payload/./setup.exe',
    'payload/CON',
    'payload/aux.txt',
    'payload/a:b.txt',
    'payload/file.',
    'payload/file ',
    'payload/\u202Eexe.txt',
    'payload/\u0000name'
  ])('rechaza %s', (badPath) => {
    expect(checkRelativePath(badPath).ok).toBe(false)
  })

  it('permite la cadena vacía solo cuando se pide explícitamente', () => {
    expect(checkRelativePath('').ok).toBe(false)
    expect(checkRelativePath('', { allowEmpty: true }).ok).toBe(true)
  })

  it('comprueba contención de rutas resolviendo prefijos', () => {
    expect(isPathInside('C:\\Games\\BPS', 'C:\\Games\\BPS\\juego\\x.exe')).toBe(true)
    expect(isPathInside('C:\\Games\\BPS', 'C:\\Games\\BPS-otro\\x.exe')).toBe(false)
    expect(isPathInside('C:\\Games\\BPS', 'C:\\Games\\BPS\\..\\x.exe')).toBe(false)
    expect(isPathInside('C:\\Games\\BPS', 'C:\\Games\\BPS', 'win32')).toBe(true)
  })

  it('genera carpetas de instalación seguras y no reservadas', () => {
    expect(slugifyGameId('example-quest')).toBe('example-quest')
    expect(slugifyGameId('Ñandú: Edición Final')).toBe('Nandu-Edicion-Final')
    expect(slugifyGameId('CON')).toBe('game-CON')
    expect(slugifyGameId('***')).toBe('juego')
  })

  it('valida rutas absolutas locales de escritura y rechaza alias de Windows', () => {
    expect(validateLocalAbsolutePath('C:\\Games\\Mi Juego').ok).toBe(true)
    expect(validateLocalAbsolutePath('d:/Games/Ñandú').ok).toBe(true)
    for (const bad of [
      '\\\\?\\C:\\Windows\\Temp\\x',
      '\\\\.\\C:\\Windows\\Temp\\x',
      '\\\\server\\share\\x',
      'C:relative',
      '\\rooted',
      'C:\\',
      'C:\\Games\\file. ',
      'C:\\Games\\CON',
      'C:\\Games\\a<b'
    ]) {
      expect(validateLocalAbsolutePath(bad).ok, bad).toBe(false)
    }
  })
})
