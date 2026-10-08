/**
 * Cross-project lookups (ADR-0093, docs/design/cross-project-escalation.md):
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
 * project, search IS `searchProjectDocuments`, the project's own search: hidden
 * folders are left out, and a restricted folder's collection is searched only
 * for a reader who may read it.
 *
 * ## Cost
 *
 * N projects are N collection searches (plus the readable restricted ones). One
 * call searches at most {@link CROSS_PROJECT_PAGE_PROJECTS} projects,
 * {@link SEARCH_CONCURRENCY} at a time, and answers with the offset of the next
 * page; the agent asks again when it wants more.
 */

import 'server-only'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { clearanceOf, getProjectFolderAccess, readableFolderIdsFor } from '@/lib/authz/folder-access'
import { recordCrossProjectHandOut, type HandOutParty } from '@/lib/conversations/cross-project-use'
import type { Project } from '@/lib/db/schema'
import { searchProjectDocuments } from '@/lib/documents/service'
import { buildProjectPromptView } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import { audienceReach, type AudienceReach } from './audience-reach'
import { searchProjectDecisions, type DecisionScope, type FoundDecision } from './decisions-repository'
import { searchPermitRequirements, type FoundPermitRecord } from '@/lib/permits/repository'
import { rankBySimilarity, similarityFacts } from './similarity'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import {
  CROSS_PROJECT_PAGE_PROJECTS,
  type CrossProjectBriefRequest,
  type CrossProjectBriefResponse,
  type CrossProjectDecision,
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

/** How many project searches run at the same time within one page. */
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
  /** The answer the turn is writing, from the request body; marked with the hand-out (ADR-0092). */
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

/** The project status as the lookups report it; kept on the wire so an agent built before ticket 1 still parses. */
export const PROJECT_STATUS_KNOWN = true

/** A project's status (ADR-0089). */
export function projectStatusOf(project: Pick<Project, 'status'>): ProjectStatus {
  return project.status === 'closed' ? 'closed' : 'active'
}

/**
 * A project's period, as days: the Steckbrief's Beginn and Abschluss (month
 * precision, migration 0117), else the day the project was created in Piloti
 * and an open end.
 */
export function projectPeriodOf(
  project: Pick<Project, 'createdAt' | 'startedOn' | 'endedOn'>
): { start: string; end: string | null } {
  const start = project.startedOn ?? new Date(project.createdAt).toISOString().slice(0, 10)
  return { start, end: project.endedOn ?? null }
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
    bundesland: similarityFacts(project.profile).bundesland,
  }
}

function listed(project: Project, currentProjectId: string | null): CrossProjectListed {
  return {
    ...projectRefOf(project),
    collection: project.collectionName,
    address: projectAddressOf(project),
    period: projectPeriodOf(project),
    current: project.id === currentProjectId,
  }
}

/**
 * The projects a search scope covers, the conversation's own left out: in the
 * listing's order (newest first), or, for `similar`, most like the current
 * project first (`similarity.ts`).
 */
export function projectsInScope(
  reachable: readonly Project[],
  request: Pick<CrossProjectSearchRequest, 'scope' | 'projectIds' | 'from' | 'to'>,
  current: { id: string; profile: Project['profile'] | null } | null
): Project[] {
  const others = reachable.filter(
    (project) => project.id !== current?.id && periodOverlaps(projectPeriodOf(project), request.from, request.to)
  )
  if (request.scope === 'similar') return rankBySimilarity(current?.profile ?? null, others)
  if (request.scope === 'closed') return others.filter((project) => projectStatusOf(project) === 'closed')
  if (request.scope === 'named') {
    const named = new Set(request.projectIds)
    return others.filter((project) => named.has(project.id))
  }
  return others
}

/** The current project, for the similarity order; null outside every project or when it is gone. */
async function currentProjectOf(caller: CrossProjectCaller): Promise<Project | null> {
  return caller.currentProjectId ? findProjectInOrg(caller.currentProjectId, caller.session.organizationId) : null
}

/** List and find the projects in reach (ADR-0093). Every project listed is recorded. */
export async function listLookupProjects(
  caller: CrossProjectCaller,
  request: CrossProjectListRequest
): Promise<CrossProjectListResponse> {
  const reach = await audienceReach(caller.session, caller.conversationId)
  const needle = request.query?.toLocaleLowerCase('de') ?? ''
  const matching = reach.projects.filter((project) => {
    if (request.status && projectStatusOf(project) !== request.status) return false
    if (!periodOverlaps(projectPeriodOf(project), request.from, request.to)) return false
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
  return { projects, total: matching.length, statusKnown: PROJECT_STATUS_KNOWN }
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

/** Whether a hit's tags satisfy the request's type and discipline filters (each group: any of). */
export function matchesTags(
  tags: readonly string[],
  request: Pick<CrossProjectSearchRequest, 'documentTypes' | 'disciplines'>
): boolean {
  const has = (wanted: readonly string[]) => wanted.length === 0 || wanted.some((tag) => tags.includes(tag))
  return has(request.documentTypes) && has(request.disciplines)
}

/**
 * How many hits to ask each project for: more when a tag filter will drop some
 * after retrieval. The tags live in the ingestion metadata store, not in the
 * chunks, so they cannot be pushed into the vector search.
 */
function perProjectTopK(request: CrossProjectSearchRequest): number {
  const filtered = request.documentTypes.length + request.disciplines.length > 0
  return Math.min(filtered ? request.limit * 3 : request.limit, 30)
}

/** A hit, and the restricted folder its passage came from (null for the project's own collection). */
interface FoundHit {
  hit: CrossProjectHit
  folderId: string | null
}

/**
 * One project's hits, through the project's own search; a project that fails
 * yields none. A passage from a restricted folder's collection carries that
 * folder, for the record; one whose folder cannot be named is dropped rather
 * than handed out unrecorded.
 */
async function searchOneProject(
  session: AuthorizedSession,
  project: Project,
  request: CrossProjectSearchRequest,
  reach: Pick<AudienceReach, 'restrictedFolders'>
): Promise<FoundHit[]> {
  let found: Awaited<ReturnType<typeof searchProjectDocuments>>
  try {
    // Every hit goes to the model: screened rows only, never the asker's own
    // held uploads in that project nor what they review in its quarantine.
    found = await searchProjectDocuments(session, project.id, request.query, perProjectTopK(request), {
      snippetMaxChars: CROSS_PROJECT_SNIPPET_CHARS,
      forModel: true,
    })
  } catch {
    // Access withdrawn between the listing and the search, or the project went: nothing from it.
    return []
  }
  const ref = projectRefOf(project)
  // `collectionName` on a found hit is the collection the PASSAGE came from:
  // `joinHitsToFiles` joins a hit only to the row of the hit's own collection,
  // so this is the hit's collection and not a filename match with a row filed
  // elsewhere. Restricted or not, and which folder, is decided from it alone.
  // A shared chat searches no restricted folder: not every reader was asked about it.
  const matching = found.hits.filter(
    (hit) => matchesTags(hit.tags ?? [], request) && (reach.restrictedFolders || hit.collectionName === project.collectionName)
  )
  const restricted = matching.some((hit) => hit.collectionName !== project.collectionName)
  const access = restricted ? await getProjectFolderAccess(session, project.id, project.collectionName) : null
  return matching.flatMap((hit) => {
    const folderId = hit.collectionName === project.collectionName ? null : (access?.sourceFolderOf(hit.collectionName) ?? null)
    if (hit.collectionName !== project.collectionName && !folderId) return []
    return [
      {
        folderId,
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
  return {
    project: projectRefOf(project),
    collection: project.collectionName,
    kind: found.kind === 'constraint' ? 'constraint' : 'decision',
    content: found.content,
    confirmed: found.confirmed,
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

/** Search documents, recorded decisions and permit records across the projects in reach, one bounded page of projects per call (ADR-0093). */
export async function searchAcrossProjects(
  caller: CrossProjectCaller,
  request: CrossProjectSearchRequest
): Promise<CrossProjectSearchResponse> {
  const [reach, current] = await Promise.all([
    audienceReach(caller.session, caller.conversationId),
    request.scope === 'similar' ? currentProjectOf(caller) : Promise.resolve(null),
  ])
  const scope = projectsInScope(
    reach.projects,
    request,
    current ?? (caller.currentProjectId ? { id: caller.currentProjectId, profile: null } : null)
  )
  const page = scope.slice(request.offset, request.offset + CROSS_PROJECT_PAGE_PROJECTS)
  const memoryScopes = decisionScopes(caller.session, page, reach)
  // Decisions and permit records are judged over the same scopes: the same
  // projects, the same folder clearance, so the two cannot disagree on reach.
  const [perProject, decided, permitted] = await Promise.all([
    mapBounded(page, SEARCH_CONCURRENCY, (project) => searchOneProject(caller.session, project, request, reach)),
    memoryScopes.then((scopes) => searchProjectDecisions(caller.session.organizationId, scopes, request.query)),
    memoryScopes.then((scopes) => searchPermitRequirements(caller.session.organizationId, scopes, request.query)),
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
  const kept = perProject
    .flat()
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, request.limit)
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
    statusKnown: PROJECT_STATUS_KNOWN,
  }
}
