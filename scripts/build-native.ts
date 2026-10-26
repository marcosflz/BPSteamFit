import { buildNativeHelper } from './build-native-helper'

buildNativeHelper({ force: process.argv.includes('--force') })
  .then((outputPath) => {
    console.log(`OK  Auxiliar de elevación generado: ${outputPath}`)
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
