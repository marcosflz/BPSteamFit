import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { manifestSchema } from '../src/shared/manifest'

async function main(): Promise<void> {
  const jsonSchema = z.toJSONSchema(manifestSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any'
  }) as Record<string, unknown>

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://bpsteamfit.local/schemas/manifest-v1.schema.json',
    title: 'BPSteamFit .game manifest v1',
    description:
      'Manifiesto para paquetes .game. Un .game es un ZIP con manifest.json y payload/. No se admiten scripts, hooks ni comandos de shell.',
    ...jsonSchema
  }

  await mkdir(resolve('schema'), { recursive: true })
  await writeFile(resolve('schema/manifest.schema.json'), `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
  console.log('schema/manifest.schema.json generado')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
