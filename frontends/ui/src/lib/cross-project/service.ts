/**
 * Cross-project lookups (ADR-0094, docs/design/cross-project-escalation.md):
 * list and find the projects in reach, read one project's brief, and search
 * documents across them. The one place that decides what a lookup may return;
 * the agent's routes (`app/api/internal/cross-project/*`) are thin adapters
 * over it.
 *
 * ## Who may ask, and what is recorded
 *
 * Any chat. A lookup searches AS THE CONVERSATION'S AUDIENCE
 * (`audience-reach.ts`): a solo chat reaches what its asker may chat in, a
 * shared one what every reader may open, which always includes the office's
 * closed projects. Every answer is recorded on the conversation BEFORE it is
 * returned (`recordCrossProjectHandOut`): the projects it says anything about
 * and the restricted folders its passages came from, under the lock every
 * share takes, refused when the audience changed since the reach was computed.
 * The record then decides who may read the conversation next and what may leave
 * it; a project closed now restricts nobody.
 *
 * ## Access, with no second rule
 *
 * A project is in reach when the reader may CHAT in it (`listChatProjects`, the
 * rule a chat turn's own scope uses: a project viewer reads documents but does
 * not get the agent pointed at them). The conversation's own project is never
 * in a lookup's scope; its own tools search it under its own scope. Inside a
 * project, the collections searched are the ones the project's own search
 * names (`planProjectSearch`): hidden folders are left out, and a restricted
 * folder's collection is searched only for a reader who may read it.
 *
 * ## Fact filters narrow, likeness still ranks
 *
 * A search or a listing may ask for only projects with given facts
 * (`projectFacts`: Bundesland, Gebäudeklasse, Bauweise, Nutzungen,
 * Vorhabensart). They are judged on the Postgres profile (`holdsFacts`) over
 * what the audience's reach already holds, before the page is cut, so a filter
 * can only narrow the reach, and `projectsInScope`, the paging, the decisions
 * and the permits all count the same narrowed set. In `similar` and `closed`
 * the likeness order and the search's likeness lift still rank what is left.
 *
 * ## Cost
 *
 * Qdrant is the one store (ADR-0113), with one shared index (ADR-0114), so a
 * page of up to {@link CROSS_PROJECT_PAGE_PROJECTS} projects, and at most
 * {@link BACKEND_SEARCH_MAX_COLLECTIONS} collections, is ONE search:
 * every collection the reader is cleared for, ranked together, so hits from
 * different projects are ordered by one ranking instead of by scores from
 * separate indexes. The tag filters run inside that search, and the current
 * project's fingerprint lifts passages from projects like it
 * (`project-facts-mirror.ts`); the walk order no longer decides which
 * projects are searched. A failed search is an upstream error, never an empty
 * page. The answer carries the offset of the next page; the agent asks again
 * when it wants more.
 */

import 'server-only'
import { decisionOriginOf } from './decision-origin'
import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { clearanceOf, readableFolderIdsFor } from '@/lib/authz/folder-access'
import { recordCrossProjectHandOut, type HandOutParty } from '@/lib/conversations/cross-project-use'
import type { Project } from '@/lib/db/schema'
import {
  BACKEND_SEARCH_MAX_COLLECTIONS,
  fetchGroupedSemanticHits,
  hydrateProjectHits,
  planProjectSearch,
  projectsWithinCollectionCap,
  type GroupedSearchFilters,
  type ListedDocument,
  type ProjectSearchPlan,
  type SearchedDocument,
} from '@/lib/documents/service'
import { similarityBoostOf } from './project-facts-mirror'
import { buildProjectPromptView } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import { audienceReach, type AudienceReach } from './audience-reach'
import { searchProjectDecisions, type DecisionScope, type FoundDecision } from './decisions-repository'
import { liveFolderAccess } from '@/lib/permits/live-access'
import { searchPermitRequirements, type FoundPermitRecord } from '@/lib/permits/repository'
import { bundeslandOf, rankBySimilarity, similarityFacts } from './similarity'
import { abschlussOf, toProjectStatus } from '@/lib/projects/project-status'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import {
  CROSS_PROJECT_PAGE_PROJECTS,
  type CrossProjectBriefRequest,
  type CrossProjectBriefResponse,
  type CrossProjectDecision,
  type CrossProjectFacts,
  type CrossProjectHit,
  type CrossProjectListed,
  type CrossProjectRef,
  type CrossProjectListRequest,
  type CrossProjectListResponse,
  type CrossProjectPermit,
  type CrossProjectSearchRequest,
  type CrossProjectSearchResponse,
  type ProjectStatus,
} from './types'

/** How many projects are authorized, joined to their rows or read for memory at the same time within one page. */
export const SEARCH_CONCURRENCY = 4

/**
 * How long a passage the search hands back may be. The snippet is the
 * evidence: the agent cannot open another project's document further, so a
 * person's 300-character hit-list snippet would be too thin to answer from.
 */
export const CROSS_PROJECT_SNIPPET_CHARS = 900

/** Who asks, from which conversation, in which project (null: a chat outside every project). */
export interface CrossProjectCaller {
  session: AuthorizedSession
  conversationId: string
  currentProjectId: string | null
  /** The answer the turn is writing, from the request body; marked with the hand-out (ADR-0093). */
  answerMessageId?: string | null
}

/**
 * The caller of an agent route, from the turn's VERIFIED envelope and the
 * pinned session built from it (ADR-0054 §4). A turn without a conversation has
 * nothing to keep the findings to, and is refused.
 */
export function crossProjectCaller(
  context: Pick<VerifiedGridRequestContext, 'conversationId' | 'projectId'>,
  session: AuthorizedSession,
  answerMessageId?: string | null
): CrossProjectCaller {
  if (!context.conversationId) throw new BadRequestError('A cross-project lookup needs the conversation it was asked in')
  return {
    session,
    conversationId: context.conversationId,
    currentProjectId: context.projectId ?? null,
    answerMessageId: answerMessageId ?? null,
  }
}

function party(caller: CrossProjectCaller): HandOutParty {
  return {
    organizationId: caller.session.organizationId,
    userId: caller.session.userId,
    conversationId: caller.conversationId,
    answerMessageId: caller.answerMessageId,
  }
}

/** A project's status (ADR-0098): active, paused or closed; anything unreadable reads as active. */
export function projectStatusOf(project: Pick<Project, 'status'>): ProjectStatus {
  return toProjectStatus(project.status)
}

/**
 * A project's period, as days: the Steckbrief's Beginn (month precision,
 * migration 0117), else the day the project was created in Piloti; and its
 * Abschluss once it is closed, else an open end (ADR-0098).
 */
export function projectPeriodOf(
  project: Pick<Project, 'createdAt' | 'startedOn' | 'endedOn' | 'status'>
): { start: string; end: string | null } {
  const start = project.startedOn ?? new Date(project.createdAt).toISOString().slice(0, 10)
  return { start, end: abschlussOf(project) }
}

/** Whether a period overlaps `[from, to]`, both optional and inclusive; an open end runs to today and beyond. */
export function periodOverlaps(period: { start: string; end: string | null }, from?: string, to?: string): boolean {
  return (!to || period.start <= to) && (!from || period.end === null || period.end >= from)
}

/** The project's address, from the brief's `standort_adresse` fact, when one was confirmed. */
export function projectAddressOf(project: Pick<Project, 'profile'>): string | null {
  const value = project.profile?.facts?.standort_adresse?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** What every answer says about a project it drew on: who it is, whether it is closed, and its Land. */
function projectRefOf(project: Project): CrossProjectRef {
  return {
    id: project.id,
    name: project.name,
    status: projectStatusOf(project),
    bundesland: bundeslandOf(project.profile),
  }
}

/**
 * The OIB edition a project was planned under: a confirmed fact, else the
 * agent's suggestion from its documents (unconfirmed), else null. A wizard default
 * is no evidence and is not read.
 */
export function oibEditionOf(profile: Project['profile'] | null): CrossProjectListed['oibEdition'] {
  const fact = profile?.facts?.oib_ausgabe?.value
  if (typeof fact === 'string' && fact.trim()) return { value: fact.trim(), confirmed: true }
  const suggestion = profile?.assumptions?.oib_ausgabe
  if (suggestion?.source === 'agent_suggested' && typeof suggestion.value === 'string' && suggestion.value.trim()) {
    return { value: suggestion.value.trim(), confirmed: false }
  }
  return null
}

function listed(project: Project, currentProjectId: string | null): CrossProjectListed {
  return {
    ...projectRefOf(project),
    collection: project.collectionName,
    address: projectAddressOf(project),
    period: projectPeriodOf(project),
    oibEdition: oibEditionOf(project.profile),
    current: project.id === currentProjectId,
  }
}

/**
 * Whether a project holds the facts a lookup asked for (`crossProjectFactsSchema`):
 * within a fact any of its values, across facts all of them; no filter, or an
 * empty one, holds for every project. Read off Postgres, the authority, as the
 * similarity reads a profile (`similarityFacts`), which is also what every
 * chunk's mirrored copy carries; a fact the profile does not record does not
 * match. Only ever narrows what the audience's reach already holds.
 */
export function holdsFacts(profile: Project['profile'] | null, filter: CrossProjectFacts | undefined): boolean {
  if (!filter) return true
  const facts = similarityFacts(profile)
  const anyOf = <T>(wanted: readonly T[] | undefined, held: readonly T[]) =>
    !wanted?.length || wanted.some((value) => held.includes(value))
  return (
    anyOf(filter.bundesland, facts.bundesland ? [facts.bundesland] : []) &&
    anyOf(filter.gebaeudeklasse, facts.gebaeudeklasse) &&
    anyOf(filter.bauweise, facts.bauweise) &&
    anyOf(filter.nutzungen, facts.nutzungen) &&
    anyOf(filter.vorhabensart, facts.vorhabensart)
  )
}

/**
 * The projects a search scope covers, the conversation's own left out and
 * narrowed by the period and the asked facts first: for `similar` and `closed`,
 * most like the current project first (`similarity.ts`), so a search of the
 * closed projects (the turn's precedent prefetch) walks the same projects the
 * reference catalog lists first; for `all` and `named`, in the listing's order
 * (newest first). The facts narrow every scope and reorder none.
 */
export function projectsInScope(
  reachable: readonly Project[],
  request: Pick<CrossProjectSearchRequest, 'scope' | 'projectIds' | 'from' | 'to'> &
    Partial<Pick<CrossProjectSearchRequest, 'order' | 'projectFacts'>>,
  current: { id: string; profile: Project['profile'] | null } | null
): Project[] {
  const others = reachable.filter(
    (project) =>
      project.id !== current?.id &&
      periodOverlaps(projectPeriodOf(project), request.from, request.to) &&
      holdsFacts(project.profile, request.projectFacts)
  )
  if (request.scope === 'similar') return fitFirst(rankBySimilarity(current?.profile ?? null, others), request.order)
  if (request.scope === 'closed') {
    return fitFirst(
      rankBySimilarity(
        current?.profile ?? null,
        others.filter((project) => projectStatusOf(project) === 'closed')
      ),
      request.order
    )
  }
  if (request.scope === 'named') {
    const named = new Set(request.projectIds)
    return others.filter((project) => named.has(project.id))
  }
  return others
}

/**
 * `ranked` with the projects `order` names walked first, in its order: the
 * turn's reference fit. Only a reorder of what the scope already holds; an id
 * it does not hold is ignored.
 */
function fitFirst(ranked: Project[], order: readonly string[] | undefined): Project[] {
  if (!order?.length) return ranked
  const position = new Map(order.map((id, index) => [id, index]))
  const first = ranked.filter((project) => position.has(project.id))
  first.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
  return [...first, ...ranked.filter((project) => !position.has(project.id))]
}

/** The current project, for the similarity order; null outside every project or when it is gone. */
async function currentProjectOf(caller: CrossProjectCaller): Promise<Project | null> {
  return caller.currentProjectId ? findProjectInOrg(caller.currentProjectId, caller.session.organizationId) : null
}

/** List and find the projects in reach (ADR-0094). Every project listed is recorded. */
export async function listLookupProjects(
  caller: CrossProjectCaller,
  request: CrossProjectListRequest
): Promise<CrossProjectListResponse> {
  const reach = await audienceReach(caller.session, caller.conversationId)
  const needle = request.query?.toLocaleLowerCase('de') ?? ''
  const matching = reach.projects.filter((project) => {
    if (request.status && projectStatusOf(project) !== request.status) return false
    if (!periodOverlaps(projectPeriodOf(project), request.from, request.to)) return false
    if (!holdsFacts(project.profile, request.projectFacts)) return false
    if (!needle) return true
    const haystack = `${project.name} ${projectAddressOf(project) ?? ''}`.toLocaleLowerCase('de')
    return haystack.includes(needle)
  })
  const projects = matching.slice(0, request.limit).map((project) => listed(project, caller.currentProjectId))
  await recordCrossProjectHandOut(
    party(caller),
    { projectIds: projects.filter((project) => !project.current).map((project) => project.id), folderIds: [] },
    reach.key
  )
  return { projects, total: matching.length }
}

/** One project's brief: its confirmed facts and its summary, for a project in reach. Recorded. */
export async function readProjectBrief(
  caller: CrossProjectCaller,
  request: CrossProjectBriefRequest
): Promise<CrossProjectBriefResponse> {
  const reach = await audienceReach(caller.session, caller.conversationId)
  // The conversation's own project is always readable here; any other must be in reach.
  const project =
    reach.projects.find((candidate) => candidate.id === request.projectId) ??
    (request.projectId === caller.currentProjectId ? await currentProjectOf(caller) : null)
  if (!project) throw new NotFoundError()
  let facts = ''
  try {
    facts = buildProjectPromptView(project.profile)
  } catch {
    // A profile that does not parse has no facts to tell; the name and summary still do.
  }
  const brief = {
    project: listed(project, caller.currentProjectId),
    summary: project.profileDisplay?.summary?.trim() || null,
    facts,
  }
  if (!brief.project.current) {
    await recordCrossProjectHandOut(party(caller), { projectIds: [project.id], folderIds: [] }, reach.key)
  }
  return brief
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
 * Whether a hit's tags satisfy the request's type and discipline filters (each
 * group: any of). Behind the grouped search, which filters on the chunks' copy
 * of the tags, a backstop that judges by the document row.
 */
export function matchesTags(
  tags: readonly string[],
  request: Pick<CrossProjectSearchRequest, 'documentTypes' | 'disciplines'>
): boolean {
  const has = (wanted: readonly string[]) => wanted.length === 0 || wanted.some((tag) => tags.includes(tag))
  return has(request.documentTypes) && has(request.disciplines)
}

/** A hit, and the restricted folder its passage came from (null for the project's own collection). */
interface FoundHit {
  hit: CrossProjectHit
  folderId: string | null
  /** Position in the page's one ranking, when the page was searched at once. */
  rank?: number
}

/**
 * The hits of one project a reader may be handed: the request's tag filters,
 * no restricted folder in a shared chat, and every restricted passage
 * carrying the folder it came from (one whose folder cannot be named is
 * dropped rather than handed out unrecorded).
 */
async function foundHitsOf(
  project: Project,
  found: Array<SearchedDocument<ListedDocument>>,
  request: CrossProjectSearchRequest,
  reach: Pick<AudienceReach, 'restrictedFolders'>,
  accessOf: () => Promise<{ sourceFolderOf: (collection: string) => string | null | undefined }>
): Promise<FoundHit[]> {
  const ref = projectRefOf(project)
  // `collectionName` on a found hit is the collection the PASSAGE came from:
  // `joinHitsToFiles` joins a hit only to the row of the hit's own collection,
  // so this is the hit's collection and not a filename match with a row filed
  // elsewhere. Restricted or not, and which folder, is decided from it alone.
  // A shared chat searches no restricted folder: not every reader was asked about it.
  const matching = found.filter(
    (hit) => matchesTags(hit.tags ?? [], request) && (reach.restrictedFolders || hit.collectionName === project.collectionName)
  )
  const restricted = matching.some((hit) => hit.collectionName !== project.collectionName)
  const access = restricted ? await accessOf() : null
  return matching.flatMap((hit) => {
    const folderId = hit.collectionName === project.collectionName ? null : (access?.sourceFolderOf(hit.collectionName) ?? null)
    if (hit.collectionName !== project.collectionName && !folderId) return []
    return [
      {
        folderId,
        ...(hit.rank === undefined ? {} : { rank: hit.rank }),
        hit: {
          project: ref,
          documentId: hit.id,
          filename: hit.filename,
          title: hit.displayName && hit.displayName !== hit.filename ? hit.displayName : null,
          collection: hit.collectionName,
          page: hit.page,
          snippet: hit.snippet,
          score: hit.score,
          tags: hit.tags ?? [],
          uploadedAt: new Date(hit.createdAt).toISOString(),
        },
      },
    ]
  })
}

/** What one page's search found, and how many of the page's projects it covered. */
interface SearchedPage {
  found: FoundHit[]
  /** The page's leading projects searched; the rest wait for the next page (the backend's collection cap). */
  searched: number
}

/**
 * A page of projects in ONE search (ADR-0114): each project is authorized and
 * its cleared collections named exactly as its own search names them
 * (`planProjectSearch`), then every collection is ranked together and each
 * project's hits are joined to its screened rows. A shared chat does not even
 * search a restricted folder, rather than searching and discarding it.
 *
 * One search names at most {@link BACKEND_SEARCH_MAX_COLLECTIONS}
 * collections, and each project brings its own plus every restricted folder
 * the reader is cleared for. The page stops at the project that would pass
 * the cap; it and the ones after it are searched on the next page.
 *
 * A project whose access went between the listing and the search yields
 * nothing. A page not one project of which could be planned (a database
 * failure, or every access withdrawn at once) is an upstream error rather than
 * an empty page reported as searched.
 */
async function searchPage(
  session: AuthorizedSession,
  page: readonly Project[],
  request: CrossProjectSearchRequest,
  reach: Pick<AudienceReach, 'restrictedFolders'>,
  current: Pick<Project, 'profile'> | null
): Promise<SearchedPage> {
  const planned = await mapBounded(page, SEARCH_CONCURRENCY, (project) =>
    planProjectSearch(session, project.id).catch(() => null)
  )
  if (page.length > 0 && planned.every((plan) => plan === null)) {
    throw new UpstreamError('No project of the page could be authorized for the search')
  }
  const collectionsOf = (plan: ProjectSearchPlan) =>
    reach.restrictedFolders ? plan.collections : [plan.project.collectionName]
  const searched = projectsWithinCollectionCap(planned.map((plan) => (plan ? collectionsOf(plan).length : 0)))
  const plans = planned.slice(0, searched).filter((plan): plan is ProjectSearchPlan => plan !== null)
  // The tag filters run inside the search, so a project is asked for exactly
  // `limit` documents; `matchesTags` below stays as a backstop.
  const hits = await fetchGroupedSemanticHits(
    plans.flatMap(collectionsOf).slice(0, BACKEND_SEARCH_MAX_COLLECTIONS),
    request.query,
    request.limit,
    CROSS_PROJECT_SNIPPET_CHARS,
    { filters: tagFiltersOf(request), boost: current ? similarityBoostOf(current.profile) : null }
  )
  const perProject = await mapBounded(plans, SEARCH_CONCURRENCY, async (plan) => {
    const own = new Set(collectionsOf(plan))
    const projectHits = hits.filter((hit) => own.has(hit.collection))
    if (projectHits.length === 0) return []
    // A join that fails is a failed search, never a project with nothing found.
    const found = await hydrateProjectHits(session, plan, projectHits, {
      snippetMaxChars: CROSS_PROJECT_SNIPPET_CHARS,
      forModel: true,
    }).catch((error: unknown) => {
      throw new UpstreamError(
        'The hits could not be joined to their documents',
        error instanceof Error ? error.message : undefined
      )
    })
    return foundHitsOf(plan.project, found, request, reach, async () => plan.access)
  })
  return { found: perProject.flat(), searched }
}

/**
 * The request's type and discipline filters as the grouped search's pre-filters; undefined when none.
 *
 * The fact filter is deliberately not sent as `project_facts`: the page holds
 * only projects whose Postgres profile matches (`projectsInScope`), so the
 * collections named already carry it. The chunks' mirrored copy can lag (a
 * backfilled chunk carries no facts until the weekly sync), and filtering on
 * it too would drop a project the authority says matches.
 */
function tagFiltersOf(request: CrossProjectSearchRequest): GroupedSearchFilters | undefined {
  if (request.documentTypes.length + request.disciplines.length === 0) return undefined
  return {
    ...(request.documentTypes.length ? { document_types: [...request.documentTypes] } : {}),
    ...(request.disciplines.length ? { disciplines: [...request.disciplines] } : {}),
  }
}

/** Best first: by the page's one ranking when it has one, else by score. */
function byRelevance(a: FoundHit, b: FoundHit): number {
  if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank
  return b.hit.score - a.hit.score
}

/**
 * What of each project's memory the reader may see: in a chat that is the
 * asker's alone, every restricted item the asker is cleared for in THAT
 * project (ticket 1's per-project clearance); elsewhere open memory only, as
 * passages from restricted folders stay out of a shared chat.
 */
async function decisionScopes(
  session: AuthorizedSession,
  projects: readonly Project[],
  reach: Pick<AudienceReach, 'restrictedFolders'>
): Promise<DecisionScope[]> {
  if (!reach.restrictedFolders) return projects.map((project) => ({ projectId: project.id, readableFolderIds: [] }))
  return mapBounded(projects, SEARCH_CONCURRENCY, async (project) => ({
    projectId: project.id,
    readableFolderIds: await readableFolderIdsFor(
      session.organizationId,
      project.id,
      await clearanceOf(session, project.id)
    ),
  }))
}

function asDecision(found: FoundDecision, byId: ReadonlyMap<string, Project>): CrossProjectDecision | null {
  const project = byId.get(found.projectId)
  if (!project) return null
  const origin = decisionOriginOf(found)
  return {
    project: projectRefOf(project),
    collection: project.collectionName,
    kind: found.kind === 'constraint' ? 'constraint' : 'decision',
    content: found.content,
    origin,
    confirmed: origin === 'person',
    evidence: found.evidence,
    recordedAt: found.updatedAt.toISOString(),
    restricted: found.restrictedFolderIds !== null,
  }
}

function asPermit(found: FoundPermitRecord, byId: ReadonlyMap<string, Project>): CrossProjectPermit | null {
  const project = byId.get(found.projectId)
  if (!project) return null
  return {
    project: projectRefOf(project),
    collection: found.collectionName,
    fileName: found.fileName,
    kind: found.kind,
    authority: found.authority,
    municipality: found.municipality,
    issuedOn: found.issuedOn,
    reference: found.reference,
    requirements: found.requirements,
    restricted: found.restrictedFolderIds !== null,
  }
}

/** Search documents, recorded decisions and permit records across the projects in reach, one bounded page of projects per call (ADR-0094). */
export async function searchAcrossProjects(
  caller: CrossProjectCaller,
  request: CrossProjectSearchRequest
): Promise<CrossProjectSearchResponse> {
  const [audience, current] = await Promise.all([
    audienceReach(caller.session, caller.conversationId),
    request.scope === 'similar' || request.scope === 'closed' ? currentProjectOf(caller) : Promise.resolve(null),
  ])
  // `openFoldersOnly` searches as a shared chat would: no restricted folder, so nothing that narrows the readers.
  const reach = request.openFoldersOnly ? { ...audience, restrictedFolders: false } : audience
  const scope = projectsInScope(
    reach.projects,
    request,
    current ?? (caller.currentProjectId ? { id: caller.currentProjectId, profile: null } : null)
  )
  const candidates = scope.slice(request.offset, request.offset + CROSS_PROJECT_PAGE_PROJECTS)
  const { found: documents, searched } = await searchPage(caller.session, candidates, request, reach, current)
  // What the collection cap deferred is the next page's, decisions and permits included.
  const page = candidates.slice(0, searched)
  const memoryScopes = decisionScopes(caller.session, page, reach)
  // Decisions and permit records are judged over the same scopes: the same
  // projects, the same folder clearance, so the two cannot disagree on reach.
  const [decided, permitted] = await Promise.all([
    memoryScopes.then((scopes) => searchProjectDecisions(caller.session.organizationId, scopes, request.query)),
    memoryScopes.then(async (scopes) =>
      searchPermitRequirements(
        caller.session.organizationId,
        // Permits are judged by the document's live folder (permits/live-access.ts), from the same clearance.
        await mapBounded(scopes, SEARCH_CONCURRENCY, async (scope) => ({
          projectId: scope.projectId,
          access: await liveFolderAccess(caller.session.organizationId, scope.projectId, scope.readableFolderIds),
        })),
        request.query
      )
    ),
  ])
  const byId = new Map(page.map((project) => [project.id, project]))
  const decisions = decided.flatMap((found) => {
    const decision = asDecision(found, byId)
    return decision ? [{ decision, folderIds: found.restrictedFolderIds ?? [] }] : []
  })
  const permits = permitted.flatMap((found) => {
    const permit = asPermit(found, byId)
    return permit ? [{ permit, folderIds: found.restrictedFolderIds ?? [] }] : []
  })
  const kept = [...documents].sort(byRelevance).slice(0, request.limit)
  // Recorded before anything is returned: the projects and restricted folders
  // of the hits AND of the decisions and permit records handed out.
  await recordCrossProjectHandOut(
    party(caller),
    {
      projectIds: [
        ...kept.map((found) => found.hit.project.id),
        ...decisions.map(({ decision }) => decision.project.id),
        ...permits.map(({ permit }) => permit.project.id),
      ],
      folderIds: [
        ...kept.map((found) => found.folderId).filter((folderId): folderId is string => folderId !== null),
        ...decisions.flatMap(({ folderIds }) => folderIds),
        ...permits.flatMap(({ folderIds }) => folderIds),
      ],
    },
    reach.key
  )
  const next = request.offset + page.length
  return {
    decisions: decisions.map(({ decision }) => decision),
    permits: permits.map(({ permit }) => permit),
    hits: kept.map((found) => found.hit),
    projectsInScope: scope.length,
    projectsSearched: page.length,
    nextOffset: next < scope.length ? next : null,
  }
}
