/**
 * Parser tolerante y mínimo del VDF de texto de Steam. Solo se usa para leer
 * config/loginusers.vdf (persona y cuenta más reciente). No se usa para
 * shortcuts.vdf, que es binario, y no se serializa de vuelta.
 *
 * No pretende ser un parser completo de KeyValues: acepta objetos anidados,
 * cadenas entre comillas con escapes básicos, tokens sin comillas y comentarios
 * de línea. Cualquier anomalía se comunica como resultado, no como excepción.
 */

export type TextVdfValue = string | TextVdfObject

export interface TextVdfObject {
  [key: string]: TextVdfValue
}

export interface TextVdfParseSuccess {
  ok: true
  root: TextVdfObject
  warnings: string[]
}

export interface TextVdfParseFailure {
  ok: false
  error: string
  warnings: string[]
}

export type TextVdfParseResult = TextVdfParseSuccess | TextVdfParseFailure

interface Token {
  kind: 'string' | 'open' | 'close' | 'eof'
  value?: string
  offset: number
}

const MAX_TEXT_VDF_BYTES = 2 * 1024 * 1024
const MAX_TEXT_VDF_DEPTH = 32
const MAX_TEXT_VDF_TOKENS = 200_000

function decodeText(input: Buffer | string): string {
  return typeof input === 'string' ? input : input.toString('utf8')
}

function tokenize(input: string): Token[] {
  const text = input.replace(/^\uFEFF/, '')
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_VDF_BYTES) {
    throw new Error(`El VDF de texto supera ${MAX_TEXT_VDF_BYTES} bytes.`)
  }
  const tokens: Token[] = []
  let index = 0
  const push = (kind: Token['kind'], offset: number, value?: string): void => {
    tokens.push(value === undefined ? { kind, offset } : { kind, value, offset })
    if (tokens.length > MAX_TEXT_VDF_TOKENS) {
      throw new Error('El VDF de texto tiene demasiados tokens.')
    }
  }

  while (index < text.length) {
    const char = text[index]
    if (char === undefined) break
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (char === '{') {
      push('open', index)
      index += 1
      continue
    }
    if (char === '}') {
      push('close', index)
      index += 1
      continue
    }
    if (char === '"') {
      const start = index
      index += 1
      let value = ''
      let closed = false
      while (index < text.length) {
        const current = text[index]
        if (current === undefined) break
        if (current === '"') {
          closed = true
          index += 1
          break
        }
        if (current === '\\') {
          const next = text[index + 1]
          index += 2
          if (next === undefined) break
          switch (next) {
            case 'n':
              value += '\n'
              break
            case 'r':
              value += '\r'
              break
            case 't':
              value += '\t'
              break
            case '\\':
              value += '\\'
              break
            case '"':
              value += '"'
              break
            default:
              // Escape desconocido: se conserva el carácter, sin inventar.
              value += next
              break
          }
          continue
        }
        value += current
        index += 1
      }
      if (!closed) throw new Error(`Cadena sin cerrar en el offset ${start}.`)
      push('string', start, value)
      continue
    }

    const start = index
    let value = ''
    while (index < text.length) {
      const current = text[index]
      if (current === undefined || /\s/.test(current) || current === '{' || current === '}') break
      value += current
      index += 1
    }
    if (value.length === 0) throw new Error(`Token inesperado en el offset ${start}.`)
    push('string', start, value)
  }
  push('eof', text.length)
  return tokens
}

function parseTokenObject(
  tokens: Token[],
  cursor: { index: number },
  depth: number,
  warnings: string[]
): TextVdfObject {
  if (depth > MAX_TEXT_VDF_DEPTH) throw new Error('El VDF de texto supera la profundidad máxima.')
  const object: TextVdfObject = Object.create(null) as TextVdfObject
  while (true) {
    const token = tokens[cursor.index]
    if (!token) throw new Error('Fin de tokens inesperado.')
    if (token.kind === 'eof') return object
    if (token.kind === 'close') return object
    if (token.kind !== 'string') {
      throw new Error(`Se esperaba una clave en el offset ${token.offset}.`)
    }
    const key = token.value ?? ''
    cursor.index += 1
    const next = tokens[cursor.index]
    if (!next) throw new Error('Fin de tokens inesperado tras una clave.')
    if (next.kind === 'open') {
      cursor.index += 1
      const child = parseTokenObject(tokens, cursor, depth + 1, warnings)
      const close = tokens[cursor.index]
      if (!close || close.kind !== 'close') {
        throw new Error(`El objeto "${key}" no tiene cierre.`)
      }
      cursor.index += 1
      if (key in object) warnings.push(`Clave duplicada en VDF de texto: ${key}.`)
      object[key] = child
    } else if (next.kind === 'string') {
      cursor.index += 1
      if (key in object) warnings.push(`Clave duplicada en VDF de texto: ${key}.`)
      object[key] = next.value ?? ''
    } else {
      throw new Error(`La clave "${key}" no tiene valor.`)
    }
  }
}

export function parseTextVdf(input: Buffer | string): TextVdfParseResult {
  const warnings: string[] = []
  try {
    const text = decodeText(input)
    const tokens = tokenize(text)
    const cursor = { index: 0 }
    const root = parseTokenObject(tokens, cursor, 0, warnings)
    const tail = tokens[cursor.index]
    if (!tail || tail.kind !== 'eof') {
      throw new Error(`Contenido inesperado en el offset ${tail?.offset ?? 0}.`)
    }
    return { ok: true, root, warnings }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      warnings
    }
  }
}

export function getTextVdfValue(object: TextVdfObject, key: string): TextVdfValue | undefined {
  const lower = key.toLowerCase()
  for (const existing of Object.keys(object)) {
    if (existing.toLowerCase() === lower) return object[existing]
  }
  return undefined
}

export function getTextVdfObject(object: TextVdfObject, key: string): TextVdfObject | undefined {
  const value = getTextVdfValue(object, key)
  return value && typeof value === 'object' ? value : undefined
}

export function getTextVdfString(object: TextVdfObject, key: string): string | undefined {
  const value = getTextVdfValue(object, key)
  return typeof value === 'string' ? value : undefined
}
