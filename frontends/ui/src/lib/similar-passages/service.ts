/**
 * „Im Büro behandelt": the passages like the one a person is reading, from
 * everything that person may read — this project's other documents, the
 * office's other projects (closed ones included), the Büroablage.
 *
 * ## Who decides what may come back
 *
 * This service, before and after the search. The backend ranks only what it
 * is signed into, and every collection it is signed into was authorized here:
 *
 * - **The source document** is read through `getAccessibleDocument`, the rule
 *   every item route applies (project FGA and folder visibility, Büroablage
 *   membership, the hold). A document whose content has not passed the
 *   office's screening is refused even to its uploader: its text would go to
 *   the embedder, a model, before anyone cleared it (ADR-0086).
 * - **The reader's own project** (the source document's, else the one they
 *   work in) is the one they are reading in: `project:view` is enough for it.
 * - **The other projects** are the reach of a chat that is the person's alone
 *   (`listChatProjects`, the solo row of `audience-reach.ts`): every project
 *   they may chat in, every closed project of the office. Nothing here enters
 *   a transcript, so no other reader widens or narrows it, and nothing is
 *   recorded. Each project is then authorized and its collections named by
 *   `planProjectSearch`, the project's own search: `project:view`, hidden
 *   folders left out, a restricted folder's collection only when the person is
 *   cleared for it.
 * - **The Büroablage** is any member's.
 * - **Every hit becomes a row through the reader `SCREENED_ONLY`**, so a held
 *   document's passage is never shown, its uploader's and its reviewers'
 *   included. The quarantine has its own queue; a list of suggestions from
 *   across the office is no place for a file nobody has cleared. A hit no row
 *   answers is dropped, and the source document never comes back.
 *
 * ## Cost
 *
 * One backend call: a nearest-neighbour query over at most
 * {@link SIMILAR_MAX_PROJECTS} projects' collections and the Büroablage, and
 * never more than the backend's {@link BACKEND_SEARCH_MAX_COLLECTIONS}: the
 * projects most like the reader's are walked first, and the walk stops at the
 * one whose collections would pass it. A cited passage is matched to its
 * stored chunk there and costs no embedding.
 */

import 'server-only'
import { getAccessibleDocument } from '@/lib/documents/access'
import { hasPassedScreening, SCREENED_ONLY } from '@/lib/documents/document-reader'
import {
  BACKEND_SEARCH_MAX_COLLECTIONS,
  hydrateProjectHits,
  joinHitsToFiles,
  planProjectSearch,
  projectsWithinCollectionCap,
  type BackendSearchHit,
  type ProjectSearchPlan,
  type SearchedDocument,
} from '@/lib/documents/service'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { toListedDocuments } from '@/lib/documents/shelf-listing'
import { archivCollectionName } from '@/lib/archiv/collection'
import { findArchivDocumentsByFilenames } from '@/lib/archiv/repository'
import { BadRequestError, ServiceUnavailableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-proxy'
import { rankBySimilarity } from '@/lib/cross-project/similarity'
import { CROSS_PROJECT_PAGE_PROJECTS } from '@/lib/cross-project/types'
import type { Project } from '@/lib/db/schema'
import { fassungTag } from '@/features/documents/lib/fassung-timeline'
import { listChatProjects } from '@/lib/projects/service'
import { toProjectStatus } from '@/lib/projects/project-status'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import type {
  SimilarDocument,
  SimilarGroup,
  SimilarPassagesRequest,
  SimilarPassagesResponse,
} from './types'

/** Projects searched in one ask, the reader's own included: the cross-project search's one-query page. */
export const SIMILAR_MAX_PROJECTS = CROSS_PROJECT_PAGE_PROJECTS
/** Documents the answer lists, and passages per document. */
export const SIMILAR_DOCUMENTS = 12
export const SIMILAR_PASSAGES_PER_DOCUMENT = 3
/** How many project authorizations run at once. */
const PLAN_CONCURRENCY = 4
/** The backend call's bound; a hung backend is an error state, not a spinner forever. */
const BACKEND_TIMEOUT_MS = 15_000

/** The base corpus the legal citations come from (`collection-scope-request.ts` resolves the same name). */
function baseCollectionName(): string {
  return process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
}

/** What the backend needs to know about the source: where it is stored, and the project it belongs to. */
interface ResolvedSource {
  collection: string
  fileName: string
  documentId: string | null
  projectId: string | null
}

/** The source document, read as the person may read it; a held one is refused (see the module docstring). */
async function resolveSource(
  session: AuthorizedSession,
  document: SimilarPassagesRequest['document']
): Promise<ResolvedSource> {
  if (document.kind === 'base') {
    return { collection: baseCollectionName(), fileName: document.fileName, documentId: null, projectId: null }
  }
  const row = await getAccessibleDocument(session, document.documentId)
  if (!hasPassedScreening(row)) {
    throw new BadRequestError('This document has not passed screening yet', { reason: 'held' })
  }
  return { collection: row.collectionName, fileName: row.filename, documentId: row.id, projectId: row.projectId }
}

/** Run `work` over `items`, at most `limit` at a time, in order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))))
  }
  return results
}

/**
 * The other projects searched besides the reader's own: those most like it
 * first, closed ones included, up to the bound with the reader's own counted.
 */
export function otherProjectsToSearch(reach: readonly Project[], current: Pick<Project, 'id' | 'profile'> | null): Project[] {
  const others = reach.filter((project) => project.id !== current?.id)
  return rankBySimilarity(current?.profile ?? null, others).slice(0, SIMILAR_MAX_PROJECTS - (current ? 1 : 0))
}

/** One document of the backend's answer (`SimilarDocument` in `aiq_api/models/similar.py`). */
interface BackendSimilarDocument {
  collection: string
  file_name: string
  passages: Array<{ chunk_id: string; snippet: string; page_number: number | null; score: number }>
}

interface BackendSimilarResponse {
  documents: BackendSimilarDocument[]
  origin: 'point' | 'embedded'
}

/**
 * `POST /v1/collections/similar`, signed for exactly the collections searched
 * plus the source's own (the backend reads the source point's vector there).
 * A hit from a collection this call did not name is dropped rather than trusted.
 */
async function fetchSimilarFromBackend(
  source: ResolvedSource,
  passage: SimilarPassagesRequest['passage'],
  collections: readonly string[]
): Promise<BackendSimilarResponse> {
  const scope = [...new Set([source.collection, ...collections])]
  const headers = buildGridRequestContextWireHeaders({ collectionScope: scope }, process.env.GRID_INTERNAL_API_TOKEN)
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/collections/similar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        source: {
          collection: source.collection,
          file_name: source.fileName,
          text: passage.text,
          page: passage.page ?? null,
          kind: passage.cited ? 'cited' : 'selected',
          document_id: source.documentId,
        },
        collections,
        documents: SIMILAR_DOCUMENTS,
        passages_per_document: SIMILAR_PASSAGES_PER_DOCUMENT,
      }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new ServiceUnavailableError('Similar passages could not be searched')
  }
  if (!res.ok) throw new ServiceUnavailableError('Similar passages could not be searched')
  const body = (await res.json().catch(() => null)) as Partial<BackendSimilarResponse> | null
  if (!body || !Array.isArray(body.documents)) throw new ServiceUnavailableError('Similar passages could not be searched')
  const allowed = new Set(collections)
  return {
    origin: body.origin === 'point' ? 'point' : 'embedded',
    documents: body.documents.filter((document) => allowed.has(document.collection)),
  }
}

/**
 * The backend's documents as search hits, one per passage, each carrying its
 * document's place in the ranking: the shape `joinHitsToFiles` turns into rows.
 */
export function asSearchHits(documents: readonly BackendSimilarDocument[]): BackendSearchHit[] {
  return documents.flatMap((document, rank) =>
    document.passages.map((passage) => ({
      file_name: document.file_name,
      collection: document.collection,
      snippet: passage.snippet,
      page_number: passage.page_number,
      score: passage.score,
      rank,
    }))
  )
}

/** The Büroablage's hits as rows, screened ones only. */
async function hydrateArchivHits(
  session: AuthorizedSession,
  hits: BackendSearchHit[]
): Promise<Array<SearchedDocument<ListedDocument>>> {
  if (hits.length === 0) return []
  const rows = await findArchivDocumentsByFilenames(
    session.organizationId,
    hits.map((hit) => hit.file_name),
    { reader: SCREENED_ONLY }
  )
  return joinHitsToFiles(hits, await toListedDocuments(session, rows, SCREENED_ONLY))
}

/** A ranked document under construction: its rows' passages collected in ranking order. */
interface RankedDocument {
  rank: number
  document: SimilarDocument
}

/**
 * Fold one group's joined rows (one per passage) into documents, the source
 * document and every superseded Fassung left out, in ranking order.
 *
 * The backend already leaves out points marked superseded, but that mark is
 * Qdrant's copy and can lag a person's confirmation. The row is Postgres, the
 * authority, so a replaced Fassung is dropped here too, as `knowledge_search`'s
 * post-check does (ADR-0099).
 */
export function foldDocuments(
  found: ReadonlyArray<SearchedDocument<ListedDocument>>,
  excludedDocumentId: string | null
): RankedDocument[] {
  const byId = new Map<string, RankedDocument>()
  for (const row of found) {
    if (row.id === excludedDocumentId || row.fassung?.supersededBy) continue
    const entry =
      byId.get(row.id) ??
      ({
        rank: row.rank ?? Number.MAX_SAFE_INTEGER,
        document: {
          documentId: row.id,
          filename: row.filename,
          displayName: row.displayName && row.displayName !== row.filename ? row.displayName : null,
          contentType: row.contentType,
          stand: fassungTag(row.filename, row.revisionFacts ?? null),
          passages: [],
        },
      } satisfies RankedDocument)
    byId.set(row.id, entry)
    entry.document.passages.push({ page: row.page, snippet: row.snippet, score: row.score })
  }
  return [...byId.values()].sort((a, b) => a.rank - b.rank)
}

/**
 * A join of the hits to their rows that failed: the error state, never an
 * empty answer the panel would read as „Im Büro noch nicht behandelt".
 */
function joinFailed(error: unknown): never {
  console.warn('[SimilarPassages] could not join the hits to their documents', error)
  throw new ServiceUnavailableError('Similar passages could not be searched')
}

/** The group's place: its best document's. */
const bestRank = (documents: readonly RankedDocument[]): number =>
  documents.reduce((best, entry) => Math.min(best, entry.rank), Number.MAX_SAFE_INTEGER)

/**
 * Search the passages like `request.passage` across what the person may read.
 * See the module docstring for who decides what may come back.
 */
export async function findSimilarPassages(
  session: AuthorizedSession,
  request: SimilarPassagesRequest
): Promise<SimilarPassagesResponse> {
  const source = await resolveSource(session, request.document)
  const currentId = source.projectId ?? request.projectId ?? null
  // The reader's own project is the one they are reading in: `project:view`
  // (its own search's rule) is enough for it, chatting in it is not asked.
  const [currentPlan, reach] = await Promise.all([
    currentId ? planProjectSearch(session, currentId).catch(() => null) : Promise.resolve(null),
    listChatProjects(session),
  ])
  const planned = await mapBounded(
    otherProjectsToSearch(reach, currentPlan?.project ?? null),
    PLAN_CONCURRENCY,
    (project) => planProjectSearch(session, project.id).catch(() => null)
  )
  const candidates = [currentPlan, ...planned].filter((plan): plan is ProjectSearchPlan => plan !== null)
  // One search names at most BACKEND_SEARCH_MAX_COLLECTIONS, the Büroablage's
  // among them. There is no next page here: the projects past the cap are not
  // searched, and the reader's own, walked first, always is (cut to the cap).
  const projectCap = BACKEND_SEARCH_MAX_COLLECTIONS - 1
  const plans = candidates.slice(
    0,
    projectsWithinCollectionCap(
      candidates.map((plan) => plan.collections.length),
      projectCap
    )
  )
  const archiv = archivCollectionName(session.organizationId)
  const collections = [...new Set([...plans.flatMap((plan) => plan.collections).slice(0, projectCap), archiv])]

  const backend = await fetchSimilarFromBackend(source, request.passage, collections)
  const hits = asSearchHits(backend.documents)

  const projectGroups = await mapBounded(plans, PLAN_CONCURRENCY, async (plan) => {
    const own = new Set(plan.collections)
    const projectHits = hits.filter((hit) => own.has(hit.collection))
    if (projectHits.length === 0) return null
    // `forModel` selects the SCREENED_ONLY reader: no held document, whoever asks.
    const found = await hydrateProjectHits(session, plan, projectHits, { forModel: true }).catch(joinFailed)
    const documents = foldDocuments(found, source.documentId)
    if (documents.length === 0) return null
    return { plan, documents }
  })
  const archivDocuments = foldDocuments(
    await hydrateArchivHits(
      session,
      hits.filter((hit) => hit.collection === archiv)
    ).catch(joinFailed),
    source.documentId
  )

  const ranked: Array<{ rank: number; group: SimilarGroup }> = []
  for (const entry of projectGroups) {
    if (!entry) continue
    const project = entry.plan.project
    ranked.push({
      rank: entry.plan === currentPlan ? -1 : bestRank(entry.documents),
      group: {
        kind: entry.plan === currentPlan ? 'current' : 'project',
        project: { id: project.id, name: project.name, status: toProjectStatus(project.status) },
        documents: entry.documents.map((document) => document.document),
      },
    })
  }
  if (archivDocuments.length > 0) {
    ranked.push({
      rank: bestRank(archivDocuments),
      group: { kind: 'archiv', project: null, documents: archivDocuments.map((document) => document.document) },
    })
  }
  ranked.sort((a, b) => a.rank - b.rank)
  return {
    groups: ranked.map((entry) => entry.group),
    projectsSearched: plans.filter((plan) => plan !== currentPlan).length,
    origin: backend.origin,
  }
}
