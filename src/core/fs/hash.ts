import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { AppError } from '@shared/errors'

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hasher = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('INSTALL_CANCELLED', 'Lectura cancelada.'))
      return
    }
    const stream = createReadStream(filePath)
    const onAbort = (): void => {
      stream.destroy()
      reject(new AppError('INSTALL_CANCELLED', 'Lectura cancelada.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hasher.update(chunk))
    stream.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new AppError('IO_ERROR', `No se pudo leer el archivo: ${filePath}`, { cause: error }))
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    })
  })
  return hasher.digest('hex')
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    throw new AppError('IO_ERROR', `No se pudo consultar el tamaño: ${filePath}`, { cause: error })
  }
}
