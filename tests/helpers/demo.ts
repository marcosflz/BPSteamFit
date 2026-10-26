import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPackage, inspectPackage, type InspectedPackage } from '../../src/core/package/package-service'
import type { Manifest } from '../../src/shared/manifest'

export const projectRoot = process.cwd()
export const demoPackagePath = path.join(projectRoot, 'demo', 'out', 'ExampleQuest.game')
export const demoPayloadDir = path.join(projectRoot, 'demo', 'out', 'payload')

export interface DemoVariant {
  packagePath: string
  inspected: InspectedPackage
  manifest: Manifest
}

export async function buildDemoVariant(
  workDir: string,
  name: string,
  mutate: (manifest: Manifest) => void
): Promise<DemoVariant> {
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, 'demo', 'manifest.json'), 'utf8')
  ) as Manifest
  mutate(manifest)
  const variantDir = path.join(workDir, `variant-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`)
  await mkdir(variantDir, { recursive: true })
  const manifestPath = path.join(variantDir, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const packagePath = path.join(variantDir, `${name}.game`)
  await createPackage({
    manifestPath,
    payloadDir: demoPayloadDir,
    outputPath: packagePath,
    force: true
  })
  const inspected = await inspectPackage(packagePath)
  return { packagePath, inspected, manifest: inspected.manifest }
}

export async function copyDemoTo(directory: string, fileName = 'ExampleQuest.game'): Promise<string> {
  await mkdir(directory, { recursive: true })
  const destination = path.join(directory, fileName)
  await copyFile(demoPackagePath, destination)
  return destination
}
