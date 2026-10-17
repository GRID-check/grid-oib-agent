/** An error's class name for a log line: never its message, which may carry data. */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code
  return typeof code === 'string' ? `${error.name}:${code}` : error.name
}
