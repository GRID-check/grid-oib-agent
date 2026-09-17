export type DeepResearchJobLoadFailureKind =
  | 'unavailable'
  | 'backend_unreachable'
  | 'other'

const getErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }

  return typeof error === 'string' ? error : ''
}

/**
 * Read the HTTP status attached by the API clients (ApiRequestError.status).
 * Structural — avoids coupling to the adapter module while still preferring
 * the typed signal over free-text matching.
 */
const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/**
 * Text fallbacks for errors that carry no structured HTTP status. Anchored to
 * the exact messages our API clients ("Failed to <action>: 404") and the
 * backend ("Job not found") produce, so free text like a 401
 * "Signature has expired" or a 500 mentioning "route not found" can never be
 * misclassified as an unavailable job.
 */
const UNAVAILABLE_CLIENT_MESSAGE = /(?:^|:\s)Failed to [^:]+: (?:404|410)\b/
const UNAVAILABLE_BACKEND_PHRASE = /\bjob (?:not found|expired|deleted)\b/i

export const getDeepResearchJobLoadFailureKind = (
  error: unknown
): DeepResearchJobLoadFailureKind => {
  const status = getErrorStatus(error)

  // A structured HTTP status is authoritative: only 404/410 mean the job is
  // gone. Any other status (401, 500, ...) is never "unavailable", regardless
  // of what the message text mentions.
  if (status === 404 || status === 410) {
    return 'unavailable'
  }

  const errorText = getErrorText(error)

  if (
    status === undefined &&
    (UNAVAILABLE_CLIENT_MESSAGE.test(errorText) || UNAVAILABLE_BACKEND_PHRASE.test(errorText))
  ) {
    return 'unavailable'
  }

  if (
    /(?:PROXY_ERROR|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|failed to fetch|NetworkError|Load failed)/i.test(
      errorText
    )
  ) {
    return 'backend_unreachable'
  }

  return 'other'
}

export const getDeepResearchJobLoadErrorDetails = (error: unknown): string | undefined => {
  const errorText = getErrorText(error)
  return errorText.replace(/^Error:\s*/, '').trim() || undefined
}

export const isUnavailableDeepResearchJobError = (error: unknown): boolean =>
  getDeepResearchJobLoadFailureKind(error) === 'unavailable'

/** Terminal verdicts a deep-research job can carry. */
export type DeepResearchTerminalVerdict = 'success' | 'failure' | 'interrupted'

/**
 * Read the backend's own terminal verdict off a failed cancel.
 *
 * A cancel against an already-terminal job fails with 400 "Job not
 * cancellable: <id> (status: <verdict>)" — the cancel handler looked the job
 * up and names the status it found. That verdict is FRESHER than whatever the
 * status/list endpoints serve for the same job (they can lag a crashed run
 * indefinitely), so a dismiss that learns it reconciles to it instead of
 * merely marking the thread stopped and hoping the next poll agrees.
 *
 * Returns null when the error carries no terminal verdict (job gone without a
 * stated status, transient failure, or a job that is genuinely still running).
 */
export const readTerminalVerdictFromCancelError = (
  error: unknown
): DeepResearchTerminalVerdict | null => {
  const errorText = getErrorText(error)
  const match = /job not cancellable[^()]*\(\s*status:\s*([a-z_]+)\s*\)/i.exec(errorText)
  if (!match) return null

  const status = match[1].toLowerCase()
  if (status === 'success' || status === 'failure' || status === 'interrupted') {
    return status
  }
  return null
}
