import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from './redact'

export interface FileLogOptions {
  maxBytes?: number
}

/**
 * Escritor de log con truncado por tamaño y redacción de credenciales. Se usa
 * tanto para la app como para cada instalación (archivos separados).
 */
export class FileLog {
  private stream: WriteStream | null = null
  private written = 0
  private readonly maxBytes: number
  private droppedNotice = false

  private constructor(
    readonly filePath: string,
    options: FileLogOptions
  ) {
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  }

  static async create(filePath: string, options: FileLogOptions = {}): Promise<FileLog> {
    const absolute = path.resolve(filePath)
    await mkdir(path.dirname(absolute), { recursive: true })
    const log = new FileLog(absolute, options)
    log.stream = createWriteStream(absolute, { flags: 'wx', mode: 0o600 })
    await new Promise<void>((resolve, reject) => {
      log.stream?.once('open', () => resolve())
      log.stream?.once('error', reject)
    })
    return log
  }

  write(level: 'info' | 'warn' | 'error', message: string): void {
    if (!this.stream || this.stream.destroyed) return
    if (this.written >= this.maxBytes) {
      if (!this.droppedNotice) {
        this.droppedNotice = true
        this.stream.write(
          `${new Date().toISOString()} WARN  Log truncado: se alcanzó el límite de ${this.maxBytes} bytes.\n`
        )
      }
      return
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redactSecrets(message)}\n`
    this.written += Buffer.byteLength(line, 'utf8')
    this.stream.write(line)
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }

  /** Añade la salida de un proceso, línea a línea, sin acumular buffers enormes. */
  writeProcessOutput(streamName: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) this.write('info', `[setup ${streamName}] ${line}`)
    }
  }

  async close(): Promise<void> {
    const current = this.stream
    this.stream = null
    if (!current) return
    await new Promise<void>((resolve) => {
      current.end(() => resolve())
    })
  }
}
