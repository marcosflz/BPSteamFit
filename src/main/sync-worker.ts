import { runSteamSyncWorkerFromArgv } from '@core/steam/worker'

void runSteamSyncWorkerFromArgv()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(
      `sync-worker: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  })
