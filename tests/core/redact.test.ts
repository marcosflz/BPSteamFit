import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../src/core/logging/redact'

describe('redacción de logs', () => {
  it('oculta claves y tokens en formatos habituales', () => {
    const input = [
      'Authorization: Bearer abc123secret',
      'api_key=mi-clave-privada',
      '{"token":"xyz-secreto"}',
      'password: hunter2',
      'https://api.example/search?api_key=topsecret&q=game',
      'texto normal que debe conservarse'
    ].join('\n')
    const output = redactSecrets(input)
    expect(output).not.toContain('abc123secret')
    expect(output).not.toContain('mi-clave-privada')
    expect(output).not.toContain('xyz-secreto')
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('topsecret')
    expect(output).toContain('texto normal que debe conservarse')
    expect(output).toContain('[REDACTED]')
  })

  it('no modifica rutas ni mensajes sin credenciales', () => {
    const input = 'C:\\Juegos\\Example Quest\\bin\\game.exe se instaló correctamente'
    expect(redactSecrets(input)).toBe(input)
  })
})
