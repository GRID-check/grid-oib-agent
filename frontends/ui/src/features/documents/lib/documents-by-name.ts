/**
 * Resolve particular documents by filename, for the readers that need THOSE
 * documents and not the corpus: citation chips, surfaced-document cards, a file
 * operation naming its file.
 *
 * They used to read the first page of each listing and look the name up in it.
 * The listing is paged, so a correct citation of a plan older than the newest
 * 500 resolved to nothing. This asks the server by name instead
 * (`POST /api/documents/by-name`, `POST /api/archiv/documents/by-name`).
 *
 * ## One request per render, not per chip
 *
 * An answer renders a dozen chips, each asking for its own name in its own
 * effect. The names asked within one task are collected and sent together on
 * the next microtask — React runs a commit's effects in one pass, so a whole
 * answer's chips land in one batch — and each name's answer is cached for the
 * page's lifetime (until a document change clears it, as it clears the other
 * indexes). A failed lookup is not cached, so a later mount asks again.
 */

import { createDocumentByNameClient, ByNameResolveError, type ResolvedDocumentRow } from '@/lib/documents/by-name-client'
import { onDocumentsChanged } from '@/lib/documents/document-changes'

/** Every row answering to one name, per shelf. */
export interface NamedDocuments {
  /** The project's rows (none without a project). */
  projekt: ResolvedDocumentRow[]
  /** The org Archiv's rows (none when the Archiv is gated off). */
  buero: ResolvedDocumentRow[]
  /**
   * A GENUINE failure (network, 5xx, a refused project) — the answer may be
   * incomplete. A gated Archiv (403/404) is not one: it simply holds nothing.
   */
  error: boolean
}

/** How a name is compared: NFC, trimmed, case-folded — as the server matches it. */
export const documentNameLookupKey = (name: string): string => name.normalize('NFC').trim().toLowerCase()

/** Archiv statuses that mean "no Archiv here", not "the lookup failed". */
const SOFT_ARCHIV_STATUSES = new Set([403, 404])

const cache = new Map<string, Promise<NamedDocuments>>()

interface PendingBatch {
  names: Map<string, string>
  settle: Map<string, Array<(result: NamedDocuments) => void>>
}
const pending = new Map<string, PendingBatch>()

let client = createDocumentByNameClient()

/** Test hook — clears the cache and any batch not yet sent. */
export const resetDocumentsByNameCache = (): void => {
  cache.clear()
  pending.clear()
}

/** Test hook — route the client through a fetch double. */
export const setDocumentsByNameFetch = (run?: Parameters<typeof createDocumentByNameClient>[0]): void => {
  client = createDocumentByNameClient(run)
}

// A document uploaded, renamed or deleted during the visit changes what a name
// resolves to, exactly as it does for the listing-backed indexes.
onDocumentsChanged(resetDocumentsByNameCache)

const projectScope = (projectId: string | null): string => projectId ?? '__no-project__'

async function settled(
  request: Promise<ResolvedDocumentRow[]>,
  soft: ReadonlySet<number>
): Promise<{ rows: ResolvedDocumentRow[]; failed: boolean }> {
  try {
    return { rows: await request, failed: false }
  } catch (error) {
    const status = error instanceof ByNameResolveError ? error.status : 0
    return { rows: [], failed: !soft.has(status) }
  }
}

function groupByKey(rows: ResolvedDocumentRow[]): Map<string, ResolvedDocumentRow[]> {
  const grouped = new Map<string, ResolvedDocumentRow[]>()
  for (const row of rows) {
    const key = documentNameLookupKey(row.filename)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return grouped
}

async function flush(projectId: string | null): Promise<void> {
  const scope = projectScope(projectId)
  const batch = pending.get(scope)
  pending.delete(scope)
  if (!batch) return
  const names = [...batch.names.values()]
  const [project, archiv] = await Promise.all([
    projectId
      ? settled(client.project(projectId, names), new Set())
      : Promise.resolve({ rows: [], failed: false }),
    settled(client.archiv(names), SOFT_ARCHIV_STATUSES),
  ])
  const projektByKey = groupByKey(project.rows)
  const bueroByKey = groupByKey(archiv.rows)
  const error = project.failed || archiv.failed
  for (const [key, resolvers] of batch.settle) {
    const result: NamedDocuments = {
      projekt: projektByKey.get(key) ?? [],
      buero: bueroByKey.get(key) ?? [],
      error,
    }
    for (const resolve of resolvers) resolve(result)
  }
}

function requestName(projectId: string | null, name: string, key: string): Promise<NamedDocuments> {
  const scope = projectScope(projectId)
  let batch = pending.get(scope)
  if (!batch) {
    batch = { names: new Map(), settle: new Map() }
    pending.set(scope, batch)
    queueMicrotask(() => void flush(projectId))
  }
  batch.names.set(key, name)
  return new Promise((resolve) => {
    batch.settle.set(key, [...(batch.settle.get(key) ?? []), resolve])
  })
}

/**
 * The rows answering to each of `names`, keyed by {@link documentNameLookupKey}.
 * Never rejects: a failure comes back as `error: true` on the names it touched.
 */
export async function resolveDocumentsByName(
  projectId: string | null,
  names: readonly string[]
): Promise<Map<string, NamedDocuments>> {
  const entries = await Promise.all(
    [...new Set(names.map((name) => name.trim()).filter(Boolean))].map(async (name) => {
      const key = documentNameLookupKey(name)
      const cacheKey = `${projectScope(projectId)}|${key}`
      let promise = cache.get(cacheKey)
      if (!promise) {
        promise = requestName(projectId, name, key)
        cache.set(cacheKey, promise)
        void promise.then((result) => {
          if (result.error && cache.get(cacheKey) === promise) cache.delete(cacheKey)
        })
      }
      return [key, await promise] as const
    })
  )
  return new Map(entries)
}
