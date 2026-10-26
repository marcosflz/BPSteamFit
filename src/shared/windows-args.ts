/**
 * Serialización de argumentos para la API de Windows (CommandLineToArgvW).
 * Se usa solo para el auxiliar de elevación, que debe construir una línea de
 * comandos para ShellExecuteEx. El camino normal sigue usando spawn con vector
 * de argumentos y sin shell.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""'
  if (!/[\s"]/.test(argument)) return argument

  let result = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1)
      result += '"'
      backslashes = 0
      continue
    }
    if (backslashes > 0) {
      result += '\\'.repeat(backslashes)
      backslashes = 0
    }
    result += character
  }
  if (backslashes > 0) result += '\\'.repeat(backslashes * 2)
  return `${result}"`
}

export function buildWindowsCommandLine(argumentsList: string[]): string {
  return argumentsList.map(quoteWindowsArgument).join(' ')
}
