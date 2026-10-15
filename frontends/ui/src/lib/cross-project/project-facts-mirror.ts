/**
 * The vector store's copy of each project's facts (docs/architecture/qdrant-retrieval-design.md
 * §4 "Mutable facts", §7). Postgres `projects` (profile, status) is the
 * authority; every chunk of a project's collections carries a copy, so the
 * cross-project search can filter by a fact and lift similar projects inside
 * its one query instead of choosing which projects to search at all.
 *
 * What is copied is what the similarity reads (`similarityFacts`): confirmed
 * facts, else the agent's suggestion from the documents, so the boost and the
 * reference catalog agree on what a project is. One typed endpoint writes it
 * (`PUT /v1/collections/{c}/project-facts`, ADR-0055), once per collection of
 * the project: its own and each restricted folder's.
 *
 * ## When, and what happens when it fails
 *
 * After a profile save or patch (`persistProfile`, the one choke point for
 * both) and after a lifecycle move (`setProjectStatus`), awaited but never
 * thrown: the person's change is committed and must not fail over its copy.
 * Awaiting keeps two quick saves' copies in the order they were made, and each
 * push re-reads the row, so the last one to land carries the latest commit. A
 * new document carries the facts in its ingest job (`dispatchIngest`); the
 * weekly vector reconcile pushes every project (`syncAllProjectFacts`), which
 * repairs any push that failed and fills chunks copied in by the backfill.
 *
 * A stale copy never widens access: who may read a chunk is the signed scope
 * of each search, decided here from Postgres. A fact on a chunk only ranks and
 * narrows. A backend process built without the knowledge layer's store (no
 * `llamaindex` extra) answers 409, which is not a failure: there is nothing to
 * copy to.
 */

import 'server-only'
import { currentRestrictedCollections } from '@/lib/authz/folder-access'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { Project } from '@/lib/db/schema'
import { findProjectInOrg, listProjectFactsPage, type ProjectFactsRow } from '@/lib/projects/repository'
import { toProjectStatus, type ProjectStatus } from '@/lib/projects/project-status'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import { SIMILARITY_WEIGHTS, similarityFacts } from './similarity'

/** A project's fingerprint as the Python tier reads it (`ProjectFacts` in `models/requests.py`). */
export interface ProjectFactsWire {
  bundesland: string | null
  gebaeudeklasse: number[]
  bauweise: string[]
  nutzungen: string[]
  vorhabensart: string[]
}

/** The body of `PUT /v1/collections/{c}/project-facts`, and an ingest job's `project_facts`. */
export interface ProjectFactsUpdateWire {
  facts: ProjectFactsWire
  status: ProjectStatus
}

/** The similarity weights in the Python tier's spelling; a weight added to `SIMILARITY_WEIGHTS` must be named here. */
const WEIGHT_WIRE_NAMES: { readonly [K in keyof typeof SIMILARITY_WEIGHTS]: string } = {
  bundesland: 'bundesland',
  gebaeudeklasse: 'gebaeudeklasse',
  gebaeudeklasseAdjacent: 'gebaeudeklasse_adjacent',
  bauweise: 'bauweise',
  nutzung: 'nutzung',
  nutzungMax: 'nutzung_max',
  vorhabensart: 'vorhabensart',
}

/** The grouped search's `boost`: the current project's facts and the one set of hand-set weights. */
export interface SearchBoostWire {
  facts: ProjectFactsWire
  weights: Record<string, number>
}

type Profile = Project['profile'] | null

/**
 * The bounds of `ProjectFacts` in `models/requests.py`: a token's length, and
 * each list's. The model forbids anything past them, and a refusal fails every
 * upload of the project and every boosted search with a 422, so the wire
 * leaves out what would not fit instead. The Gebäudeklasse's 1..5 is held by
 * `similarityFacts`.
 */
export const PROJECT_FACTS_LIMITS = {
  token: 80,
  gebaeudeklasse: 20,
  bauweise: 20,
  nutzungen: 40,
  vorhabensart: 20,
} as const

/** Tokens the Python tier takes: none longer than it allows, no more of them than the list holds. */
function wireTokens(values: readonly string[], max: number): string[] {
  return values.filter((value) => value.length <= PROJECT_FACTS_LIMITS.token).slice(0, max)
}

/** What the similarity reads of a profile, as the wire carries it: within what the Python tier accepts. */
export function projectFactsOf(profile: Profile): ProjectFactsWire {
  const facts = similarityFacts(profile)
  const limits = PROJECT_FACTS_LIMITS
  return {
    bundesland: facts.bundesland && facts.bundesland.length <= limits.token ? facts.bundesland : null,
    gebaeudeklasse: facts.gebaeudeklasse.slice(0, limits.gebaeudeklasse),
    bauweise: wireTokens(facts.bauweise, limits.bauweise),
    nutzungen: wireTokens(facts.nutzungen, limits.nutzungen),
    vorhabensart: wireTokens(facts.vorhabensart, limits.vorhabensart),
  }
}

/** A project's facts and status, as every chunk of it carries them. */
export function projectFactsUpdateOf(project: Pick<Project, 'profile' | 'status'>): ProjectFactsUpdateWire {
  return { facts: projectFactsOf(project.profile), status: toProjectStatus(project.status) }
}

/**
 * The boost for a search from a project with this profile; null when it has
 * no fact to share, so the search is not rescored for nothing. The weights
 * are `SIMILARITY_WEIGHTS`, sent rather than copied into Python, so the
 * catalog order and the search's lift cannot drift apart.
 */
export function similarityBoostOf(profile: Profile): SearchBoostWire | null {
  const facts = projectFactsOf(profile)
  const empty =
    facts.bundesland === null &&
    facts.gebaeudeklasse.length + facts.bauweise.length + facts.nutzungen.length + facts.vorhabensart.length === 0
  if (empty) return null
  const weights = Object.fromEntries(
    (Object.keys(WEIGHT_WIRE_NAMES) as Array<keyof typeof SIMILARITY_WEIGHTS>).map((key) => [
      WEIGHT_WIRE_NAMES[key],
      SIMILARITY_WEIGHTS[key],
    ])
  )
  return { facts, weights }
}

/** One push may take this long; a profile save waits for it, so it stays short. */
const PUSH_TIMEOUT_MS = 3_000

/** How one push ended: written, nothing to write to (no Qdrant here), or failed. */
export type PushOutcome = 'pushed' | 'unsupported' | 'failed'

/** PUT one collection's copy; never throws. */
async function putFacts(collection: string, body: ProjectFactsUpdateWire): Promise<PushOutcome> {
  try {
    const res = await fetch(`${getBackendUrl()}/v1/collections/${encodeURIComponent(collection)}/project-facts`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...buildGridRequestContextWireHeaders({ collectionScope: [collection] }, process.env.GRID_INTERNAL_API_TOKEN),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    if (res.ok) return 'pushed'
    if (res.status === 409) return 'unsupported'
    console.warn('[ProjectFacts] backend refused the facts of', collection, res.status)
    return 'failed'
  } catch (error) {
    console.warn('[ProjectFacts] could not push the facts of', collection, error)
    return 'failed'
  }
}

/** Push one project's facts onto every collection it has; the worst outcome of them. */
export async function pushProjectFacts(project: ProjectFactsRow): Promise<PushOutcome> {
  let collections: string[]
  try {
    collections = [
      project.collectionName,
      ...(await currentRestrictedCollections(project.organizationId, project.id, project.collectionName)),
    ]
  } catch (error) {
    console.warn('[ProjectFacts] could not name the collections of project', project.id, error)
    return 'failed'
  }
  const body = projectFactsUpdateOf(project)
  const outcomes = await Promise.all(collections.map((collection) => putFacts(collection, body)))
  if (outcomes.includes('unsupported')) return 'unsupported'
  return outcomes.includes('failed') ? 'failed' : 'pushed'
}

/**
 * Copy a project's facts after a change to them, from the row as it is now.
 * Never throws (see the header); a project that is gone has nothing to copy.
 */
export async function syncProjectFacts(organizationId: string, projectId: string): Promise<PushOutcome | null> {
  try {
    const project = await findProjectInOrg(projectId, organizationId)
    return project ? await pushProjectFacts(project) : null
  } catch (error) {
    console.warn('[ProjectFacts] could not read project', projectId, error)
    return 'failed'
  }
}

/** A new document's ingest job's `project_facts`: the project as it is now, or null when it cannot be read. */
export async function projectFactsForIngest(
  projectId: string | null | undefined,
  organizationId: string
): Promise<ProjectFactsUpdateWire | null> {
  if (!projectId) return null
  try {
    const project = await findProjectInOrg(projectId, organizationId)
    return project ? projectFactsUpdateOf(project) : null
  } catch {
    // The weekly sync copies them later; an upload never fails over its facts.
    return null
  }
}

/** Projects read per page by the sync. */
const SYNC_PAGE = 200

/** What one sync of every project did. */
export interface ProjectFactsSyncResult {
  projects: number
  failed: number
  /** True when the deployment writes no Qdrant: the sync stopped at the first answer saying so. */
  unsupported: boolean
}

/**
 * Push every live project's facts (the backfill, and the repair of any push
 * that failed). Run by the vector reconcile, which a CronJob drives weekly and
 * a platform owner can start; stops at once on a deployment without Qdrant.
 */
export async function syncAllProjectFacts(): Promise<ProjectFactsSyncResult> {
  const result: ProjectFactsSyncResult = { projects: 0, failed: 0, unsupported: false }
  let afterId: string | null = null
  for (;;) {
    const page = await listProjectFactsPage(afterId, SYNC_PAGE)
    for (const project of page) {
      const outcome = await pushProjectFacts(project)
      if (outcome === 'unsupported') return { ...result, unsupported: true }
      result.projects += 1
      if (outcome === 'failed') result.failed += 1
    }
    if (page.length < SYNC_PAGE) return result
    afterId = page[page.length - 1].id
  }
}
