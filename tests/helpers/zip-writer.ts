import { deflateRawSync } from 'node:zlib'

export interface RawZipEntry {
  name: string
  data?: Buffer
  /** Si se define, se declara este tamaño descomprimido (sin necesidad de que coincida). */
  declaredUncompressedSize?: number
  /** bit 0 = cifrado, bit 11 = nombres UTF-8. */
  flags?: number
  /** Atributos externos del formato ZIP; se usa el modo Unix en los 16 bits altos. */
  externalFileAttributes?: number
  compress?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff, 0)
  return buffer
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/**
 * Escribe un ZIP mínimo con entradas arbitrarias para probar casos maliciosos
 * que herramientas de alto nivel no permiten construir (Zip Slip, symlinks,
 * cifrado, tamaños mentidos).
 */
export function makeRawZip(entries: RawZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data ?? Buffer.alloc(0)
    const flags = entry.flags ?? 0x800
    const method = entry.compress ? 8 : 0
    const compressedData = entry.compress ? deflateRawSync(data) : data
    // Un ZIP cifrado "tradicional" antepone 12 bytes de cabecera a los datos;
    // yauzl valida esa relación de tamaños. No es cifrado real: solo probamos
    // que el validador rechaza la entrada antes de extraerla.
    const storedData =
      (flags & 0x1) !== 0 && method === 0
        ? Buffer.concat([Buffer.alloc(12), compressedData])
        : compressedData
    const crc = crc32(data)
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(storedData.length),
      u32(uncompressedSize),
      u16(name.length),
      u16(0),
      name,
      storedData
    ])
    localParts.push(local)
    const external =
      entry.externalFileAttributes ??
      (entry.name.endsWith('/') ? 0o040755 << 16 : 0o100644 << 16)
    const central = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(storedData.length),
      u32(uncompressedSize),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(external >>> 0),
      u32(offset),
      name
    ])
    centralParts.push(central)
    offset += local.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0)
  ])
  return Buffer.concat([...localParts, centralDirectory, end])
}
