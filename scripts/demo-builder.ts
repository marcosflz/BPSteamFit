import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createPackage, type CreatedPackage } from '../src/core/package/package-service'

const execFileAsync = promisify(execFile)

const projectRoot = process.cwd()
const sourceDir = path.join(projectRoot, 'demo', 'source')
const outDir = path.join(projectRoot, 'demo', 'out')
const payloadDir = path.join(outDir, 'payload')
const manifestPath = path.join(projectRoot, 'demo', 'manifest.json')
const packagePath = path.join(outDir, 'ExampleQuest.game')
const stampPath = path.join(outDir, '.build-stamp.json')

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
]

async function findCompiler(): Promise<string> {
  for (const candidate of CSC_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Siguiente candidato.
    }
  }
  throw new Error(
    'No se encontró csc.exe de .NET Framework. El paquete demo se compila en Windows con las herramientas incluidas en el sistema.'
  )
}

async function sourceFingerprint(compiler: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(compiler)
  for (const relative of [
    'demo/manifest.json',
    'demo/source/DemoInstaller.cs',
    'demo/source/DemoGame.cs'
  ]) {
    hash.update(await readFile(path.join(projectRoot, relative)))
  }
  return hash.digest('hex')
}

export interface BuildDemoOptions {
  force?: boolean
}

export interface BuildDemoResult extends CreatedPackage {
  manifestPath: string
  payloadDir: string
}

export async function buildDemo(options: BuildDemoOptions = {}): Promise<BuildDemoResult> {
  const compiler = await findCompiler()
  const fingerprint = await sourceFingerprint(compiler)

  if (!options.force) {
    try {
      const stamp = JSON.parse(await readFile(stampPath, 'utf8')) as { fingerprint?: string }
      if (stamp.fingerprint === fingerprint) {
        const inspectedStamp = JSON.parse(
          await readFile(path.join(outDir, 'build-result.json'), 'utf8')
        ) as BuildDemoResult
        await access(inspectedStamp.outputPath)
        return inspectedStamp
      }
    } catch {
      // Se reconstruye.
    }
  }

  await mkdir(path.join(payloadDir, 'game'), { recursive: true })
  await mkdir(path.join(payloadDir, 'data'), { recursive: true })

  const commonArgs = [
    '/nologo',
    '/codepage:65001',
    '/optimize+',
    '/platform:anycpu',
    '/target:winexe',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll'
  ]

  await execFileAsync(compiler, [
    ...commonArgs,
    `/out:${path.join(payloadDir, 'setup.exe')}`,
    path.join(sourceDir, 'DemoInstaller.cs')
  ])
  await execFileAsync(compiler, [
    ...commonArgs,
    `/out:${path.join(payloadDir, 'game', 'ExampleQuest.exe')}`,
    path.join(sourceDir, 'DemoGame.cs')
  ])

  const payloadSeed =
    'BPSteamFit demo payload. Deterministic data, no commercial content, no network access.\n'
  const payloadData = Buffer.from(payloadSeed.repeat(Math.ceil(131072 / payloadSeed.length)), 'utf8')
  await writeFile(path.join(payloadDir, 'data', 'payload.bin'), payloadData.subarray(0, 131072))

  const created = await createPackage({
    manifestPath,
    payloadDir,
    outputPath: packagePath,
    force: true
  })
  const result: BuildDemoResult = {
    ...created,
    manifestPath,
    payloadDir
  }
  await writeFile(stampPath, `${JSON.stringify({ fingerprint }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(outDir, 'build-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}
