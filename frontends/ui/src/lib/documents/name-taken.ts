/**
 * The refusal of an upload whose name another document already holds, declared
 * once for the server that answers it and the browser that says it.
 *
 * Every taken-name 409 of an upload carries `details.reason = 'name_taken'`:
 * the same name filed under another restriction in the project
 * (`assertNameFreeElsewhereInProject`, ADR-0087), and a held file the uploader
 * may not see (`assertMayReplaceHeld`, ADR-0086). The second one must read
 * exactly like the first, so the person learns nothing about a hold they may
 * not know of: one reason, one sentence (`files.errors.nameTaken`), no detail.
 *
 * The race between two first uploads of one name is not this
 * (`LiveFilenameTakenError`, `live_name_taken`): the server retries it, and a
 * second loss is worth retrying from the browser too.
 *
 * No imports, so the browser can read it.
 */

export const NAME_TAKEN_REASON = 'name_taken'

/** The details a taken-name 409 carries, and nothing else: no folder, no hint of why. */
export const NAME_TAKEN_DETAILS = { reason: NAME_TAKEN_REASON } as const

/**
 * The `error` text of every taken-name 409, the same words for both causes, so
 * the raw response tells them apart no better than its details do.
 */
export function nameTakenMessage(filename: string): string {
  return `A document named "${filename}" already exists in this project. Rename the file to upload it.`
}

/** Whether a response body is a taken-name refusal (`{ error, code, details: { reason } }`). */
export function isNameTakenBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const details = (body as { details?: unknown }).details
  return !!details && typeof details === 'object' && (details as { reason?: unknown }).reason === NAME_TAKEN_REASON
}
