/**
 * The typed client for the by-name resolve (ADR-0055): the one place the
 * paths, the verb and the response parsing of "give me the rows of these
 * documents" live. The citation index, the surfaced-documents index and the
 * route specs all go through it, so no caller spells a path of its own.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import type { DocumentWireRow } from '@/features/documents/lib/file-item'
import { byNameResponseSchema } from './by-name-types'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'

export type ByNameFetch = (path: string, init?: RequestInit) => Promise<Response>

/** A resolve the API refused (or a transport failure, status 0). */
export class ByNameResolveError extends Error {
  constructor(readonly status: number) {
    super(`Document resolve failed (${status})`)
    this.name = 'ByNameResolveError'
  }
}

export const PROJECT_BY_NAME_PATH = '/api/documents/by-name'
export const ARCHIV_BY_NAME_PATH = '/api/archiv/documents/by-name'

/** A listing row as the resolve returns it: the listing's own wire row. */
export type ResolvedDocumentRow = DocumentWireRow & { collectionName?: string; updatedAt?: string }

export interface DocumentByNameClient {
  /** The project's documents with these filenames. */
  project: (projectId: string, names: readonly string[]) => Promise<ResolvedDocumentRow[]>
  /** The organization Archiv's documents with these filenames. */
  archiv: (names: readonly string[]) => Promise<ResolvedDocumentRow[]>
}

function chunks(names: readonly string[]): string[][] {
  const unique = [...new Set(names.filter((name) => name.trim().length > 0))]
  const out: string[][] = []
  for (let start = 0; start < unique.length; start += FILENAME_LOOKUP_MAX_NAMES) {
    out.push(unique.slice(start, start + FILENAME_LOOKUP_MAX_NAMES))
  }
  return out
}

export function createDocumentByNameClient(
  run: ByNameFetch = (path, init) => fetch(path, init),
): DocumentByNameClient {
  const post = async (path: string, body: Record<string, unknown>): Promise<ResolvedDocumentRow[]> => {
    let response: Response
    try {
      response = await run(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new ByNameResolveError(0)
    }
    if (!response.ok) throw new ByNameResolveError(response.status)
    // The identity fields are checked; the rest of the row is the listing's
    // own wire shape, passed through as the listing readers already take it.
    return byNameResponseSchema.parse(await response.json()).documents as unknown as ResolvedDocumentRow[]
  }
  const batched = async (path: string, names: readonly string[], extra: Record<string, unknown>) =>
    (await Promise.all(chunks(names).map((batch) => post(path, { ...extra, names: batch })))).flat()
  return {
    project: (projectId, names) => batched(PROJECT_BY_NAME_PATH, names, { projectId }),
    archiv: (names) => batched(ARCHIV_BY_NAME_PATH, names, {}),
  }
}
