export const isAuthzError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message === 'not found' ||
    message.startsWith('not found:') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}
