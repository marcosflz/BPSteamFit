import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2433"/>
      <stop offset="1" stop-color="#0a0d13"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f6cf7c"/>
      <stop offset="1" stop-color="#d68a2e"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M122 150c0-29 23-52 52-52h164c29 0 52 23 52 52v158c0 29-23 52-52 52H280l-50 56-9-56h-47c-29 0-52-23-52-52V150z" fill="#101722" stroke="#35445b" stroke-width="8"/>
  <path d="M163 160c0-11 9-20 20-20h48c49 0 84 25 84 67 0 28-15 47-37 57 28 9 46 31 46 61 0 47-37 75-94 75h-67V160zm47 93h30c21 0 33-10 33-29 0-20-13-29-35-29h-28v58zm0 110h35c24 0 37-11 37-32 0-22-14-32-39-32h-33v64z" fill="url(#amber)"/>
  <circle cx="366" cy="348" r="40" fill="#f2b84b"/>
  <path d="M352 328l30 20-30 20v-40z" fill="#16202d"/>
</svg>`

function icoFromPngs(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries: Buffer[] = []
  let offset = 6 + 16 * images.length
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

const outputDir = resolve('resources', 'branding')

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const base = sharp(Buffer.from(svg, 'utf8'))
  await base.clone().resize(512, 512).png().toFile(resolve(outputDir, 'icon.png'))
  await base.clone().resize(256, 256).png().toFile(resolve(outputDir, 'icon-256.png'))

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images: Array<{ size: number; png: Buffer }> = []
  for (const size of sizes) {
    const png = await sharp(Buffer.from(svg, 'utf8')).resize(size, size).png().toBuffer()
    images.push({ size, png })
  }
  await writeFile(resolve(outputDir, 'icon.ico'), icoFromPngs(images))
  console.log('Iconos generados en resources/branding')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
