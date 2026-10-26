import { runSteamSyncWorkerFromArgv } from './worker'

/**
 * Entrada ejecutable del auxiliar:
 *   node/tsx src/core/steam/worker-cli.ts <trabajo.json> <estado.json>
 *
 * El coordinador puede compilarlo con esbuild y lanzarlo como proceso hijo.
 * No importa Electron ni la base de datos.
 */
const invokedPath = process.argv[1] ?? ''
const isCommonJsMain =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module
if (isCommonJsMain || /worker-cli\.(?:ts|js|cjs|mjs)$/.test(invokedPath)) {
  void runSteamSyncWorkerFromArgv()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `worker-cli: ${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exitCode = 1
    })
}
