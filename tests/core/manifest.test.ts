import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareVersions, validateManifest } from '@shared/manifest'
import { makeRawZip } from '../helpers/zip-writer'

const projectRoot = process.cwd()

async function demoManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(projectRoot, 'demo', 'manifest.json'), 'utf8')
  ) as Record<string, unknown>
}

describe('manifiesto .game v1', () => {
  it('acepta el manifiesto demo y conserva valores', async () => {
    const result = validateManifest(await demoManifest())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.id).toBe('example-quest')
    expect(result.manifest.installation.profile).toBe('demo')
    expect(result.manifest.installation.arguments).toContain('/DIR={installDir}')
    expect(result.manifest.installation.workingDirectory).toBe('payload')
  })

  it('rechaza versiones de esquema desconocidas con un mensaje específico', async () => {
    const manifest = await demoManifest()
    manifest.schemaVersion = 2
    const result = validateManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.code).toBe('unsupported_schema_version')
  })

  it('rechaza variables desconocidas y llaves sueltas', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    installation.arguments = ['/S', '/DIR={installDir}', '/LOG={appData}']
    const result = validateManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('{appData}'))).toBe(true)

    installation.arguments = ['/S', '/DIR={installDir', '}']
    expect(validateManifest(manifest).ok).toBe(false)
  })

  it('rechaza path traversal, rutas absolutas y nombres reservados', async () => {
    for (const badPath of ['../setup.exe', 'C:/setup.exe', '/payload/setup.exe', 'payload/CON', 'payload/a:b']) {
      const manifest = await demoManifest()
      const installation = manifest.installation as Record<string, unknown>
      installation.executable = badPath
      expect(validateManifest(manifest).ok, badPath).toBe(false)
    }
  })

  it('exige que el setup esté dentro de payload/', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    installation.executable = 'setup.exe'
    const result = validateManifest(manifest)
    expect(result.ok).toBe(false)
  })

  it('rechaza claves desconocidas (sin scripts ni hooks)', async () => {
    const manifest = await demoManifest()
    ;(manifest as Record<string, unknown>).hooks = { beforeInstall: 'calc.exe' }
    expect(validateManifest(manifest).ok).toBe(false)

    const second = await demoManifest()
    const installation = second.installation as Record<string, unknown>
    installation.postInstall = ['powershell', '-c', 'whoami']
    expect(validateManifest(second).ok).toBe(false)
  })

  it('no admite que un código sea éxito y reinicio a la vez', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    installation.rebootRequiredExitCodes = [0, 3010]
    const result = validateManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('reinicio'))).toBe(true)
  })

  it('exige una verificación mínima', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    const verification = installation.verification as Record<string, unknown>
    verification.requiredFiles = []
    verification.requiredDirectories = []
    expect(validateManifest(manifest).ok).toBe(false)
  })

  it('acepta una verificación basada solo en directorios', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    const verification = installation.verification as Record<string, unknown>
    verification.requiredFiles = []
    verification.requiredDirectories = ['bin']
    const result = validateManifest(manifest)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.installation.verification.requiredDirectories).toEqual(['bin'])
  })

  it('avisa de perfiles sin argumentos silenciosos sin inyectarlos', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    installation.profile = 'inno'
    installation.arguments = ['/DIR={installDir}']
    const result = validateManifest(manifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.installation.arguments).toEqual(['/DIR={installDir}'])
    expect(result.warnings.some((warning) => warning.includes('inno'))).toBe(true)
  })

  it('avisa de elevación declarada', async () => {
    const manifest = await demoManifest()
    const installation = manifest.installation as Record<string, unknown>
    installation.requiresElevation = true
    const result = validateManifest(manifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((warning) => warning.includes('requiresElevation'))).toBe(true)
  })

  it('compara versiones numéricas y prereleases', () => {
    expect(compareVersions('1.10.0', '1.2.0')).toBe(1)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(-1)
    expect(compareVersions('2026.10', '2026.9')).toBe(1)
  })

  it('el fixture usado por las pruebas no depende de JSON externo para el ZIP', () => {
    // Protección contra imports accidentales: el helper solo construye buffers.
    expect(makeRawZip([]).length).toBe(22)
  })
})
