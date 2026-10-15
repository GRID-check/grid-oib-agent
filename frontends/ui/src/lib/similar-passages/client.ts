/**
 * The typed client of „Im Büro behandelt" (ADR-0055): the one place the path,
 * the verb and the response parsing live. The panel calls it; the route spec
 * drives the real handler through it.
 *
 * No `server-only`: the browser imports this.
 */

import type { SimilarPassagesRequest, SimilarPassagesResponse } from './types'

export const SIMILAR_PASSAGES_PATH = '/api/passages/similar'

/** Why the search gave no answer: the document is held (not screened yet), or anything else. */
export type SimilarPassagesFailure = 'held' | 'failed'

export class SimilarPassagesError extends Error {
  constructor(
    readonly status: number,
    readonly reason: SimilarPassagesFailure
  ) {
    super(`Similar passages failed (${status}, ${reason})`)
    this.name = 'SimilarPassagesError'
  }
}

type Fetcher = typeof fetch

const isResponse = (body: unknown): body is SimilarPassagesResponse =>
  typeof body === 'object' &&
  body !== null &&
  Array.isArray((body as { groups?: unknown }).groups) &&
  typeof (body as { projectsSearched?: unknown }).projectsSearched === 'number'

/** The reason a refusal names, from the BFF's error body (`{ error, code, details: { reason } }`). */
async function failureOf(res: Response): Promise<SimilarPassagesFailure> {
  const body = (await res.json().catch(() => null)) as { details?: { reason?: unknown } } | null
  return body?.details?.reason === 'held' ? 'held' : 'failed'
}

/** Ask for the passages like `request.passage`. Throws {@link SimilarPassagesError} on any refusal or transport failure. */
export async function fetchSimilarPassages(
  request: SimilarPassagesRequest,
  options: { signal?: AbortSignal; fetcher?: Fetcher } = {}
): Promise<SimilarPassagesResponse> {
  const fetcher = options.fetcher ?? fetch
  let res: Response
  try {
    res = await fetcher(SIMILAR_PASSAGES_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new SimilarPassagesError(0, 'failed')
  }
  if (!res.ok) throw new SimilarPassagesError(res.status, await failureOf(res))
  const body: unknown = await res.json().catch(() => null)
  if (!isResponse(body)) throw new SimilarPassagesError(res.status, 'failed')
  return body
}
