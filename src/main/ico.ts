import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { isPathInside } from '@shared/safe-path'

function readPngSize(png: Buffer): { width: number; height: number } {
  const signature = '89504e470d0a1a0a'
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature) {
    throw new AppError('ARTWORK_INVALID', 'El icono no es un PNG válido para generar el .ico.')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width < 16 || height < 16 || width > 1024 || height > 1024) {
    throw new AppError('ARTWORK_INVALID', 'El PNG del icono tiene dimensiones no admitidas.')
  }
  return { width, height }
}

/**
 * ICO con una sola imagen PNG embebida (soportado por Windows Vista+).
 * Se usa para el campo `icon` de shortcuts.vdf, no para sustituir el artwork
 * de biblioteca (que va en config/grid).
 */
export function pngToIco(png: Buffer): Buffer {
  const { width, height } = readPngSize(png)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(width >= 256 ? 0 : width, 0)
  entry.writeUInt8(height >= 256 ? 0 : height, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

export async function createShortcutIcon(
  previewPngPath: string,
  iconsDirectory: string,
  gameId: string
): Promise<string> {
  const png = await readFile(previewPngPath)
  const ico = pngToIco(png)
  const safeName = gameId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'game'
  const base = path.resolve(iconsDirectory)
  const target = path.join(base, `${safeName}.ico`)
  if (!isPathInside(base, target)) {
    throw new AppError('ARTWORK_INVALID', 'La ruta del icono de Steam escapó de la carpeta gestionada.')
  }
  await mkdir(base, { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, ico, { flag: 'wx' })
  await rename(temporary, target)
  return target
}
