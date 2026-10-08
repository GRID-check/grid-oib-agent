/**
 * Similar closed projects, for the person reading one project
 * (`/app/projects/{id}/referenzen`, docs/design/closed-project-experience.md).
 *
 * ## Who sees what
 *
 * The same access as the person already has, with no second rule. The listing
 * is `listProjects` (the projects the reader may view, a closed project open to
 * every member, ADR-0089); a project not in it never reaches this file's output.
 * A project's decisions are `getProjectMemory`'s, so a restricted item shows
 * only to a reader cleared for every folder it came from; its permit records
 * are `listPermitRecordsForPerson`, the same clearance. A project whose read is
 * refused between the listing and the read is dropped, not shown partly.
 *
 * Ranked as the cross-project lookups rank (`similarity.ts`), so the page and
 * the agent's catalog agree on what is most alike.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { memoryOriginOf } from '@/lib/cross-project/decision-origin'
import { oibEditionOf, projectPeriodOf } from '@/lib/cross-project/service'
import { factLabel } from '@/lib/cross-project/fingerprint'
import {
  bundeslandOf,
  rankBySimilarity,
  sharedTraits,
  similarityFacts,
  type SharedTrait,
  type SimilarityFacts,
} from '@/lib/cross-project/similarity'
import type { Project } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { isProjectClosed } from '@/lib/projects/project-status'
import { getProjectMemory, listProjects, type ProjectMemoryListItem } from '@/lib/projects/service'
import type { ListedPermitRecord } from '@/lib/permits/repository'
import { listPermitRecordsForPerson } from './permits'
import {
  SIMILAR_DECISION_SOURCES_MAX,
  SIMILAR_DECISIONS_MAX,
  SIMILAR_PERMIT_REQUIREMENTS_MAX,
  SIMILAR_PERMITS_MAX,
  SIMILAR_PROJECTS_MAX,
  type ReferenceDecision,
  type ReferenceFact,
  type ReferencePermit,
  type ReferencePeriod,
  type SimilarProject,
} from './types'

/** How many projects one page reads at the same time. */
const READ_CONCURRENCY = 4

/**
 * The Land as the page names it. A confirmed Land wins; a suggested one stands
 * in and is marked unconfirmed, as the cross-project lookups mark it.
 */
function bundeslandOfProject(profile: Project['profile'] | null): ReferenceFact<string> | null {
  const confirmed = bundeslandOf(profile)
  const token = confirmed ?? similarityFacts(profile).bundesland
  return token ? { value: factLabel('bundesland', token), confirmed: confirmed !== null } : null
}

/** A period as the page shows it: a closed project with no recorded end ends when it was closed. */
function periodOf(project: Project): ReferencePeriod {
  const period = projectPeriodOf(project)
  const closedOn = project.closedAt ? new Date(project.closedAt).toISOString().slice(0, 10) : null
  return { start: period.start, end: period.end ?? closedOn }
}

/** A shared trait as its label: the Gebäudeklasse as „GK n", the rest as the intake's own words. */
function traitLabel(trait: SharedTrait): string {
  return trait.key === 'gebaeudeklasse' ? `GK ${trait.value}` : factLabel(trait.key, trait.value)
}

/** An active decision or constraint of the project's own memory: not an organization-wide item, not a question. */
function isRecordedDecision(
  item: ProjectMemoryListItem
): item is ProjectMemoryListItem & { kind: ReferenceDecision['kind'] } {
  return (
    item.scope === 'project' &&
    item.status === 'active' &&
    (item.kind === 'decision' || item.kind === 'constraint')
  )
}

function decisionsOf(items: readonly ProjectMemoryListItem[]): ReferenceDecision[] {
  return items.filter(isRecordedDecision).slice(0, SIMILAR_DECISIONS_MAX).map((item) => ({
    id: item.id,
    kind: item.kind,
    content: item.content,
    origin: memoryOriginOf(item),
    sources: (item.evidence ?? []).slice(0, SIMILAR_DECISION_SOURCES_MAX).map(({ fileName, page }) => ({ fileName, page })),
  }))
}

function permitsOf(records: readonly ListedPermitRecord[]): ReferencePermit[] {
  return records.slice(0, SIMILAR_PERMITS_MAX).map((record) => ({
    id: record.id,
    fileName: record.fileName,
    kind: record.kind,
    authority: record.authority,
    issuedOn: record.issuedOn,
    requirements: record.requirements
      .slice(0, SIMILAR_PERMIT_REQUIREMENTS_MAX)
      .map(({ kind, content }) => ({ kind, content })),
  }))
}

/** A reader's refusal to view one project: the project is left out, the page goes on. */
function isDenial(error: unknown): boolean {
  return error instanceof NotFoundError || error instanceof ForbiddenError
}

async function referenceOf(
  session: AuthorizedSession,
  project: Project,
  current: SimilarityFacts
): Promise<SimilarProject | null> {
  let memory: ProjectMemoryListItem[]
  let permits: ListedPermitRecord[]
  try {
    ;[memory, permits] = await Promise.all([
      getProjectMemory(session, project.id),
      listPermitRecordsForPerson(session, project.id),
    ])
  } catch (error) {
    if (isDenial(error)) return null
    throw error
  }
  return {
    id: project.id,
    name: project.name,
    period: periodOf(project),
    bundesland: bundeslandOfProject(project.profile),
    oibEdition: oibEditionOf(project.profile),
    sharedTraits: sharedTraits(current, similarityFacts(project.profile)).map(traitLabel),
    decisions: decisionsOf(memory),
    permits: permitsOf(permits),
  }
}

/** Run `work` over `items`, at most `limit` at a time, keeping the order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))))
  }
  return results
}

/**
 * The closed projects most like `projectId` that the reader may view, most
 * alike first, at most {@link SIMILAR_PROJECTS_MAX}. Requires `project:view` on
 * `projectId`; the current project is never in its own list.
 */
export async function getSimilarProjects(session: AuthorizedSession, projectId: string): Promise<SimilarProject[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const [current, visible] = await Promise.all([findProjectInOrg(projectId, session.organizationId), listProjects(session)])
  if (!current) throw new NotFoundError()

  const closed = visible.filter((project) => project.id !== current.id && isProjectClosed(project))
  const ranked = rankBySimilarity(current.profile, closed).slice(0, SIMILAR_PROJECTS_MAX)
  const currentFacts = similarityFacts(current.profile)
  const found = await mapBounded(ranked, READ_CONCURRENCY, (project) => referenceOf(session, project, currentFacts))
  return found.filter((reference): reference is SimilarProject => reference !== null)
}
