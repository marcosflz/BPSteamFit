import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

export async function fixture(name: string): Promise<Buffer> {
  return readFile(path.resolve('fixtures', 'artwork', name))
}

export function dataUrl(bytes: Uint8Array | Buffer, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

export interface LocalTestServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<LocalTestServer> {
  const server = createServer((request, response) => {
    try {
      handler(request, response)
    } catch {
      response.statusCode = 500
      response.end('error')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
