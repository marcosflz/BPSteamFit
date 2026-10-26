import { z } from 'zod'
import { checkRelativePath } from './safe-path'

export const MANIFEST_SCHEMA_VERSION = 1 as const
export const INSTALLER_PROFILES = ['generic', 'inno', 'nsis', 'demo'] as const
export type InstallerProfile = (typeof INSTALLER_PROFILES)[number]

const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

function text(label: string, max: number) {
  return z
    .string()
    .min(1, `${label} no puede estar vacío.`)
    .max(max, `${label} supera ${max} caracteres.`)
    .refine((value) => !CONTROL_OR_BIDI.test(value), {
      message: `${label} contiene caracteres de control no permitidos.`
    })
}

function relativePath(label: string, options: { allowEmpty?: boolean } = {}) {
  return z.string().superRefine((value, ctx) => {
    const checked = checkRelativePath(value, { label, allowEmpty: options.allowEmpty })
    if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason })
  })
}

const argumentSchema = z
  .string()
  .min(1, 'Un argumento no puede ser una cadena vacía.')
  .max(2048, 'Un argumento supera 2048 caracteres.')
  .refine((value) => !/[\u0000\r\n]/.test(value), {
    message: 'Un argumento no puede contener NUL ni saltos de línea.'
  })
  .superRefine((value, ctx) => {
    const withoutKnown = value.replace(PLACEHOLDER_PATTERN, (full, raw: string) => {
      if (raw === 'installDir') return ''
      ctx.addIssue({
        code: 'custom',
        message: `Variable desconocida en argumento: {${raw}}. Solo se permite {installDir}.`
      })
      return full
    })
    if (/[{}]/.test(withoutKnown)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Los argumentos solo pueden usar la variable {installDir}; las llaves sueltas no están permitidas.'
      })
    }
  })

const exitCode = z.number().int().min(-2_147_483_648).max(2_147_483_647)

export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(
        /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/,
        'El id debe usar minúsculas, números, punto, guion o guion bajo, y empezar/terminar por letra o número.'
      ),
    name: text('El nombre', 200),
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/,
        'La versión debe ser numérica, por ejemplo 1.0.0 o 2026.10-beta.1.'
      ),
    metadata: z
      .strictObject({
        searchTitle: text('searchTitle', 200).optional(),
        releaseYear: z.number().int().min(1900).max(2100).optional(),
        edition: text('edition', 100).nullable().optional(),
        providerIds: z
          .record(
            z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Nombre de proveedor no válido.'),
            z.string().min(1).max(128)
          )
          .optional()
      })
      .optional(),
    installation: z
      .strictObject({
        type: z.literal('executable'),
        profile: z.enum(INSTALLER_PROFILES),
        executable: relativePath('El ejecutable del instalador'),
        workingDirectory: relativePath('El directorio de trabajo del instalador').optional(),
        arguments: z.array(argumentSchema).max(64).default([]),
        requiresElevation: z.boolean().default(false),
        successExitCodes: z.array(exitCode).min(1).max(16).default([0]),
        rebootRequiredExitCodes: z.array(exitCode).max(16).default([]),
        verification: z.strictObject({
          requiredFiles: z.array(relativePath('Un archivo requerido')).max(100).default([]),
          requiredDirectories: z.array(relativePath('Un directorio requerido')).max(50).default([]),
          timeoutSeconds: z.number().int().min(1).max(600).default(30)
        })
      })
      .superRefine((installation, ctx) => {
        if (!installation.executable.startsWith('payload/')) {
          ctx.addIssue({
            code: 'custom',
            path: ['executable'],
            message: 'El instalador debe estar dentro de payload/ según el formato .game.'
          })
        }
        const workingDirectory = installation.workingDirectory ??
          installation.executable.split('/').slice(0, -1).join('/')
        if (workingDirectory !== 'payload' && !workingDirectory.startsWith('payload/')) {
          ctx.addIssue({
            code: 'custom',
            path: ['workingDirectory'],
            message: 'El directorio de trabajo debe estar dentro de payload/.'
          })
        }
        const overlap = installation.successExitCodes.filter((code) =>
          installation.rebootRequiredExitCodes.includes(code)
        )
        if (overlap.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['rebootRequiredExitCodes'],
            message: `Un código de salida no puede ser éxito y reinicio a la vez: ${overlap.join(', ')}.`
          })
        }
      }),
    launch: z.strictObject({
      executable: relativePath('El ejecutable de lanzamiento'),
      arguments: z.array(argumentSchema).max(64).default([]),
      workingDirectory: relativePath('El directorio de trabajo de lanzamiento').optional()
    }),
    steam: z
      .strictObject({
        enabled: z.boolean().default(true),
        displayName: text('El nombre de Steam', 200).optional(),
        tags: z.array(text('Una etiqueta de Steam', 64)).max(20).default([])
      })
      .default({ enabled: true, tags: [] })
  })
  .superRefine((manifest, ctx) => {
    const verification = manifest.installation.verification
    if (verification.requiredFiles.length === 0 && verification.requiredDirectories.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['installation', 'verification'],
        message: 'Define al menos un archivo o directorio de verificación.'
      })
    }
  })

export type Manifest = z.infer<typeof manifestSchema>
export type ManifestInput = z.input<typeof manifestSchema>

export interface ManifestIssue {
  path: string
  code: string
  message: string
}

export type ManifestValidationResult =
  | { ok: true; manifest: Manifest; warnings: string[] }
  | { ok: false; issues: ManifestIssue[]; warnings: string[] }

export function validateManifest(input: unknown): ManifestValidationResult {
  const warnings: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      warnings,
      issues: [
        {
          path: '$',
          code: 'not_object',
          message: 'El manifiesto debe ser un objeto JSON.'
        }
      ]
    }
  }

  const schemaVersion = (input as Record<string, unknown>).schemaVersion
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      warnings,
      issues: [
        {
          path: 'schemaVersion',
          code: 'unsupported_schema_version',
          message:
            schemaVersion === undefined
              ? 'Falta schemaVersion.'
              : `schemaVersion ${String(schemaVersion)} no es compatible. Esta versión admite ${MANIFEST_SCHEMA_VERSION}.`
        }
      ]
    }
  }

  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '$',
      code: issue.code,
      message: issue.message
    }))
    return { ok: false, issues, warnings }
  }

  const manifest = parsed.data
  const args = manifest.installation.arguments.join(' ').toLowerCase()
  if (manifest.installation.profile === 'inno' && !/\/verysilent|\/silent/.test(args)) {
    warnings.push(
      'Perfil inno: los argumentos no parecen incluir modo silencioso. El instalador podría mostrar su propia interfaz; no se añaden argumentos automáticamente.'
    )
  }
  if (manifest.installation.profile === 'nsis' && !/(^|\s)\/s(\s|$)/.test(args)) {
    warnings.push(
      'Perfil nsis: los argumentos no parecen incluir /S. No se añaden argumentos automáticamente; verifica que este instalador acepte el modo silencioso.'
    )
  }
  if (manifest.installation.requiresElevation) {
    warnings.push(
      'El paquete declara requiresElevation. En esta versión la elevación automática está limitada: Windows puede pedir UAC y el mando no puede controlar el escritorio seguro.'
    )
  }
  if (manifest.steam.enabled && manifest.launch.executable === manifest.installation.executable) {
    warnings.push('El ejecutable de lanzamiento coincide con el instalador; revisa que sea el juego instalado, no el setup.')
  }
  return { ok: true, manifest, warnings }
}

export function parseManifest(input: unknown): Manifest {
  const result = validateManifest(input)
  if (!result.ok) {
    const first = result.issues[0]
    throw new Error(`Manifiesto inválido: ${first?.path ?? '$'}: ${first?.message ?? 'error desconocido'}`)
  }
  return result.manifest
}

/** Comparación numérica tolerante; no pretende sustituir a semver completo. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { parts: number[]; prerelease: string } => {
    const [main = '', prerelease = ''] = value.split(/[-+]/, 2)
    return {
      parts: main.split('.').map((part) => Number.parseInt(part, 10) || 0),
      prerelease
    }
  }
  const left = split(a)
  const right = split(b)
  const max = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < max; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease.localeCompare(right.prerelease)
}
