const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]'],
  [/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]'],
  [/("(?:api[_-]?key|token|secret|password)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"']
]

/** Elimina patrones evidentes de credenciales antes de escribir un log. */
export function redactSecrets(value: string): string {
  let result = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}
