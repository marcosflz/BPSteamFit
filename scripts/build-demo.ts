import { buildDemo } from './demo-builder'

buildDemo({ force: process.argv.includes('--force') })
  .then((result) => {
    console.log('OK  Paquete demo generado')
    console.log(`Paquete: ${result.outputPath}`)
    console.log(`Tamaño:  ${(result.size / 1024).toFixed(1)} KiB`)
    console.log(`SHA-256: ${result.sha256}`)
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
