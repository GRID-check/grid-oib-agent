/**
 * The typed client for the name probe (ADR-0055): the one place the paths,
 * the verbs and the response parsing of "which of these names exist" live.
 *
 * The upload planner calls it; the route specs drive the real handlers through
 * it, so the client and the routes cannot disagree about a path or a field.
 * Responses are PARSED, not cast — see `lifecycle-client.ts` for why.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { nameProbeResponseSchema, type DocumentNameMatch } from './name-probe-types'

export type NameProbeFetch = (path: string, init?: RequestInit) => Promise<Response>

/** A probe the API refused; the status says whether it is worth retrying. */
export class NameProbeError extends Error {
  constructor(readonly status: number) {
    super(`Name probe failed (${status})`)
    this.name = 'NameProbeError'
  }
}

export const PROJECT_NAME_PROBE_PATH = '/api/documents/name-matches'
export const ARCHIV_NAME_PROBE_PATH = '/api/archiv/documents/name-matches'

export interface DocumentNameProbeClient {
  /** Matches on a project's shelf. */
  project: (projectId: string, names: readonly string[]) => Promise<DocumentNameMatch[]>
  /** Matches in the organization's Archiv. */
  archiv: (names: readonly string[]) => Promise<DocumentNameMatch[]>
}

export function createDocumentNameProbeClient(
  run: NameProbeFetch = (path, init) => fetch(path, init),
): DocumentNameProbeClient {
  const post = async (path: string, body: unknown): Promise<DocumentNameMatch[]> => {
    const response = await run(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new NameProbeError(response.status)
    return nameProbeResponseSchema.parse(await response.json()).documents
  }
  return {
    project: (projectId, names) =>
      names.length === 0 ? Promise.resolve([]) : post(PROJECT_NAME_PROBE_PATH, { projectId, names: [...names] }),
    archiv: (names) => (names.length === 0 ? Promise.resolve([]) : post(ARCHIV_NAME_PROBE_PATH, { names: [...names] })),
  }
}
