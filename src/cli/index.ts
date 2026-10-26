#!/usr/bin/env node
import { AppError, serializeError } from '../shared/errors'
import { createPackage, inspectPackage, summarizeManifest } from '../core/package/package-service'
import { ZipArchive } from '../core/package/zip'

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Map<string, string | boolean>
}

const HELP = `gamepack 0.1.0 — utilidades del formato .game

Uso:
  gamepack validate <archivo.game> [--json]
  gamepack inspect <archivo.game> [--json]
  gamepack create --manifest <manifest.json> --payload <carpeta> --out <archivo.game> [--force] [--json]
  gamepack entries <archivo.game> [--json]
  gamepack version

El formato .game es un ZIP estándar con extensión .game:
  manifest.json
  payload/... (incluye setup.exe)

Opciones:
  --json    Salida legible por máquina.
  --force   Sobrescribe la salida solo en create.
`

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help'
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()
  const valueFlags = new Set(['manifest', 'payload', 'out'])

  for (let index = 1; index < argv.length; index += 1) {
    const raw = argv[index] ?? ''
    if (!raw.startsWith('--')) {
      positionals.push(raw)
      continue
    }
    const [name = '', inline] = raw.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    if (!name) throw new AppError('VALIDATION_ERROR', 'Opción vacía.')
    if (valueFlags.has(name)) {
      const value = inline ?? argv[++index]
      if (!value) throw new AppError('VALIDATION_ERROR', `Falta el valor de --${name}.`)
      flags.set(name, value)
      continue
    }
    if (name === 'json' || name === 'force' || name === 'help') {
      if (inline !== undefined) {
        throw new AppError('VALIDATION_ERROR', `--${name} no acepta valor.`)
      }
      flags.set(name, true)
      continue
    }
    throw new AppError('VALIDATION_ERROR', `Opción desconocida: --${name}`)
  }
  return { command, positionals, flags }
}

function humanInspection(
  inspected: Awaited<ReturnType<typeof inspectPackage>>,
  json: boolean
): string {
  if (json) {
    return JSON.stringify(
      {
        ok: true,
        package: {
          filePath: inspected.filePath,
          fileName: inspected.fileName,
          size: inspected.size,
          sha256: inspected.sha256,
          entryCount: inspected.entryCount,
          payloadFiles: inspected.payloadFiles,
          payloadBytes: inspected.payloadBytes
        },
        manifest: inspected.manifest,
        warnings: inspected.warnings
      },
      null,
      2
    )
  }
  const summary = summarizeManifest(inspected.manifest)
  const lines = [
    'OK  Paquete válido',
    `Archivo:     ${inspected.fileName}`,
    `Tamaño:      ${(inspected.size / 1024 / 1024).toFixed(2)} MiB`,
    `SHA-256:     ${inspected.sha256 || '(no calculado)'}`,
    `Entradas:    ${inspected.entryCount}`,
    `Payload:     ${inspected.payloadFiles} archivos, ${(inspected.payloadBytes / 1024 / 1024).toFixed(2)} MiB`,
    `ID:          ${String(summary.id)}`,
    `Nombre:      ${String(summary.name)}`,
    `Versión:     ${String(summary.version)}`,
    `Perfil:      ${String(summary.profile)}`,
    `Instalador:  ${String(summary.setup)}`,
    `Lanzar:      ${String(summary.launch)}`,
    `Steam:       ${summary.steam ? 'sí' : 'no'}`
  ]
  if (inspected.warnings.length > 0) {
    lines.push('Avisos:')
    for (const warning of inspected.warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}

async function requireArg(args: ParsedArgs, index: number, description: string): Promise<string> {
  const value = args.positionals[index]
  if (!value) throw new AppError('VALIDATION_ERROR', `Falta ${description}.`)
  return value
}

async function main(): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    const serialized = serializeError(error)
    console.error(serialized.message)
    console.error('')
    console.error(HELP)
    return 2
  }

  const json = args.flags.get('json') === true
  if (args.flags.get('help') === true || args.command === 'help' || args.command === '--help') {
    console.log(HELP)
    return 0
  }
  if (args.command === 'version') {
    console.log('0.1.0')
    return 0
  }

  try {
    if (args.command === 'validate' || args.command === 'inspect') {
      const file = await requireArg(args, 0, 'la ruta del archivo .game')
      const inspected = await inspectPackage(file)
      if (args.command === 'inspect') {
        if (json) {
          const archive = await ZipArchive.open(file)
          const entries = archive.plan.entries.map((entry) => ({
            path: entry.normalizedPath,
            directory: entry.directory,
            size: entry.size
          }))
          archive.close()
          console.log(
            JSON.stringify(
              {
                ok: true,
                package: { filePath: inspected.filePath, size: inspected.size, sha256: inspected.sha256 },
                manifest: inspected.manifest,
                entries,
                warnings: inspected.warnings
              },
              null,
              2
            )
          )
        } else {
          console.log(humanInspection(inspected, false))
          const archive = await ZipArchive.open(file)
          console.log('\nEntradas del ZIP:')
          for (const entry of archive.plan.entries.slice(0, 80)) {
            console.log(`  ${entry.directory ? 'd' : 'f'} ${entry.normalizedPath}${entry.directory ? '/' : ` (${entry.size} B)`}`)
          }
          if (archive.plan.entries.length > 80) {
            console.log(`  … y ${archive.plan.entries.length - 80} entradas más`)
          }
          archive.close()
        }
        return 0
      }
      console.log(humanInspection(inspected, json))
      return 0
    }

    if (args.command === 'entries') {
      const file = await requireArg(args, 0, 'la ruta del archivo .game')
      const archive = await ZipArchive.open(file)
      try {
        if (json) {
          console.log(
            JSON.stringify(
              archive.plan.entries.map((entry) => ({
                path: entry.normalizedPath,
                directory: entry.directory,
                size: entry.size,
                compressedSize: entry.compressedSize
              })),
              null,
              2
            )
          )
        } else {
          for (const entry of archive.plan.entries) {
            console.log(
              `${entry.directory ? 'd' : 'f'} ${entry.normalizedPath}${entry.directory ? '/' : ` (${entry.size} B)`}`
            )
          }
        }
      } finally {
        archive.close()
      }
      return 0
    }

    if (args.command === 'create') {
      const manifestPath = args.flags.get('manifest')
      const payloadDir = args.flags.get('payload')
      const outputPath = args.flags.get('out')
      if (typeof manifestPath !== 'string' || typeof payloadDir !== 'string' || typeof outputPath !== 'string') {
        throw new AppError(
          'VALIDATION_ERROR',
          'create requiere --manifest <ruta>, --payload <carpeta> y --out <archivo.game>.'
        )
      }
      const created = await createPackage({
        manifestPath,
        payloadDir,
        outputPath,
        force: args.flags.get('force') === true
      })
      const inspected = await inspectPackage(created.outputPath)
      if (json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              package: created,
              manifest: inspected.manifest,
              warnings: inspected.warnings
            },
            null,
            2
          )
        )
      } else {
        console.log('OK  Paquete creado')
        console.log(`Archivo: ${created.outputPath}`)
        console.log(`Tamaño:  ${(created.size / 1024 / 1024).toFixed(2)} MiB`)
        console.log(`SHA-256: ${created.sha256}`)
        for (const warning of inspected.warnings) console.log(`Aviso: ${warning}`)
      }
      return 0
    }

    console.error(`Comando desconocido: ${args.command}`)
    console.error('')
    console.error(HELP)
    return 2
  } catch (error) {
    const serialized = serializeError(error)
    if (json) {
      console.log(JSON.stringify({ ok: false, error: serialized }, null, 2))
    } else {
      console.error(`ERROR [${serialized.code}] ${serialized.message}`)
      const details = serialized.details as
        | { issues?: Array<{ path: string; message: string }>; entry?: string }
        | undefined
      if (details?.issues) {
        for (const issue of details.issues) {
          console.error(`  - ${issue.path ?? '$'}: ${issue.message}`)
        }
      }
    }
    return 1
  }
}

void main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(serializeError(error))
    process.exitCode = 1
  })
