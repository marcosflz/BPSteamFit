import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = process.cwd()
const sourcePath = path.join(projectRoot, 'native', 'ElevateHelper.cs')
const outputDir = path.join(projectRoot, 'resources', 'native')
const outputPath = path.join(outputDir, 'bpsfit-elevate.exe')
const stampPath = path.join(outputDir, '.build-stamp')
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
]

export interface BuildHelperOptions {
  force?: boolean
}

export async function buildNativeHelper(options: BuildHelperOptions = {}): Promise<string> {
  const compiler = await (async () => {
    for (const candidate of CSC_CANDIDATES) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Siguiente candidato.
      }
    }
    throw new Error('No se encontró csc.exe para compilar el auxiliar de elevación.')
  })()

  const fingerprint = createHash('sha256')
    .update(compiler)
    .update(await readFile(sourcePath))
    .digest('hex')

  if (!options.force) {
    try {
      const stamp = await readFile(stampPath, 'utf8')
      if (stamp.trim() === fingerprint) {
        await access(outputPath)
        return outputPath
      }
    } catch {
      // Se compila.
    }
  }

  await mkdir(outputDir, { recursive: true })
  await execFileAsync(compiler, [
    '/nologo',
    '/codepage:65001',
    '/optimize+',
    '/platform:anycpu',
    '/target:winexe',
    '/r:System.Web.Extensions.dll',
    `/out:${outputPath}`,
    sourcePath
  ])
  await access(outputPath)
  await (await import('node:fs/promises')).writeFile(stampPath, fingerprint, 'utf8')
  return outputPath
}
