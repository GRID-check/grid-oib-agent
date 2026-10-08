/**
 * Cross-project lookups for a solo chat (ADR-0093): list and find the projects
 * the reader may chat in, read one project's brief, and search documents across
 * them. The one place that decides what a lookup may return; the agent's routes
 * (`app/api/internal/cross-project/*`) are thin adapters over it.
 *
 * ## Who may ask, and what is recorded
 *
 * Only a conversation that is its asker's alone. Every answer is recorded on
 * the conversation BEFORE it is returned (`recordCrossProjectHandOut`): the
 * projects it says anything about and the restricted folders its passages came
 * from, under the lock every share takes, with the solo check repeated there.
 * The record then decides who may read the conversation and what may leave it.
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
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { getProjectFolderAccess } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  isSoloAudience,
  recordCrossProjectHandOut,
  sharedChatRefusal,
  type HandOutParty,
} from '@/lib/conversations/cross-project-use'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { getDb } from '@/lib/db'
import type { Project } from '@/lib/db/schema'
import { searchProjectDocuments } from '@/lib/documents/service'
import { buildProjectPromptView } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import { listChatProjects } from '@/lib/projects/service'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import {
  CROSS_PROJECT_PAGE_PROJECTS,
  type CrossProjectBriefRequest,
  type CrossProjectBriefResponse,
  type CrossProjectHit,
  type CrossProjectListed,
  type CrossProjectListRequest,
  type CrossProjectListResponse,
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

/** Refuse early, before any search: the hand-out record checks again under the lock. */
export async function requireSoloConversation(session: AuthorizedSession, conversationId: string): Promise<void> {
  const audience = await readConversationAudience(getDb(), session.organizationId, conversationId)
  if (!isSoloAudience(audience, session.userId)) throw sharedChatRefusal()
}

/**
 * Whether project status is recorded. Ticket 1 adds `projects.status`; until it
 * lands every project reads as active and a `closed` scope finds nothing, and
 * every answer says so. The follow-up is {@link projectStatusOf},
 * {@link projectPeriodOf} and this flag.
 */
export const PROJECT_STATUS_KNOWN = false

/** A project's status, as the lookups report it. */
export function projectStatusOf(project: Pick<Project, 'id'>): ProjectStatus {
  void project
  return 'active'
}

/**
 * A project's period, as days. Until ticket 1 records a start and an end
 * (Beginn, Abschluss), the start is the day the project was created in Piloti
 * and the period is open.
 */
export function projectPeriodOf(project: Pick<Project, 'createdAt'>): { start: string; end: string | null } {
  return { start: new Date(project.createdAt).toISOString().slice(0, 10), end: null }
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

function listed(project: Project, currentProjectId: string | null): CrossProjectListed {
  return {
    id: project.id,
    name: project.name,
    status: projectStatusOf(project),
    collection: project.collectionName,
    address: projectAddressOf(project),
    period: projectPeriodOf(project),
    current: project.id === currentProjectId,
  }
}

/** The projects a search scope covers, in the listing's order, the conversation's own left out. */
export function projectsInScope(
  reachable: readonly Project[],
  request: Pick<CrossProjectSearchRequest, 'scope' | 'projectIds' | 'from' | 'to'>,
  currentProjectId: string | null
): Project[] {
  const others = reachable.filter(
    (project) =>
      project.id !== currentProjectId && periodOverlaps(projectPeriodOf(project), request.from, request.to)
  )
  if (request.scope === 'closed') return others.filter((project) => projectStatusOf(project) === 'closed')
  if (request.scope === 'named') {
    const named = new Set(request.projectIds)
    return others.filter((project) => named.has(project.id))
  }
  return others
}

/** List and find the projects the reader may chat in (ADR-0093). Every project listed is recorded. */
export async function listLookupProjects(
  caller: CrossProjectCaller,
  request: CrossProjectListRequest
): Promise<CrossProjectListResponse> {
  await requireSoloConversation(caller.session, caller.conversationId)
  const needle = request.query?.toLocaleLowerCase('de') ?? ''
  const matching = (await listChatProjects(caller.session, 'newest')).filter((project) => {
    if (request.status && projectStatusOf(project) !== request.status) return false
    if (!periodOverlaps(projectPeriodOf(project), request.from, request.to)) return false
    if (!needle) return true
    const haystack = `${project.name} ${projectAddressOf(project) ?? ''}`.toLocaleLowerCase('de')
    return haystack.includes(needle)
  })
  const projects = matching.slice(0, request.limit).map((project) => listed(project, caller.currentProjectId))
  await recordCrossProjectHandOut(party(caller), {
    projectIds: projects.filter((project) => !project.current).map((project) => project.id),
    folderIds: [],
  })
  return { projects, total: matching.length, statusKnown: PROJECT_STATUS_KNOWN }
}

/** One project's brief: its confirmed facts and its summary, for a reader who may chat in it. Recorded. */
export async function readProjectBrief(
  caller: CrossProjectCaller,
  request: CrossProjectBriefRequest
): Promise<CrossProjectBriefResponse> {
  await requireSoloConversation(caller.session, caller.conversationId)
  await requireProjectAccess(caller.session, request.projectId, CHAT_PERMISSIONS)
  const project = await findProjectInOrg(request.projectId, caller.session.organizationId)
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
    await recordCrossProjectHandOut(party(caller), { projectIds: [project.id], folderIds: [] })
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
  request: CrossProjectSearchRequest
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
  const ref = { id: project.id, name: project.name, status: projectStatusOf(project) }
  const matching = found.hits.filter((hit) => matchesTags(hit.tags ?? [], request))
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

/** Search documents across the projects the reader may chat in, one bounded page of projects per call (ADR-0093). */
export async function searchAcrossProjects(
  caller: CrossProjectCaller,
  request: CrossProjectSearchRequest
): Promise<CrossProjectSearchResponse> {
  await requireSoloConversation(caller.session, caller.conversationId)
  const scope = projectsInScope(await listChatProjects(caller.session, 'newest'), request, caller.currentProjectId)
  const page = scope.slice(request.offset, request.offset + CROSS_PROJECT_PAGE_PROJECTS)
  const perProject = await mapBounded(page, SEARCH_CONCURRENCY, (project) =>
    searchOneProject(caller.session, project, request)
  )
  const kept = perProject
    .flat()
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, request.limit)
  // Recorded before anything is returned: the projects and restricted folders of the hits handed out.
  await recordCrossProjectHandOut(party(caller), {
    projectIds: kept.map((found) => found.hit.project.id),
    folderIds: kept.map((found) => found.folderId).filter((folderId): folderId is string => folderId !== null),
  })
  const next = request.offset + page.length
  return {
    hits: kept.map((found) => found.hit),
    projectsInScope: scope.length,
    projectsSearched: page.length,
    nextOffset: next < scope.length ? next : null,
    statusKnown: PROJECT_STATUS_KNOWN,
  }
}
