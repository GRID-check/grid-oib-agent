/**
 * The office's reference projects, as a short catalog the agent sees at the
 * start of every turn (docs/design/cross-project-escalation.md): the closed
 * projects most like the current one, one line each, so the agent knows what
 * the office has built and can look there on its own (`project_lookup`)
 * instead of waiting to be asked. The pattern is a skill catalog: a description
 * per entry in context, the content fetched only when relevant.
 *
 * Only CLOSED projects are listed. Every office member may read a closed
 * project's name and facts (ADR-0090), so the catalog is safe in any
 * conversation, solo or shared, and listing it records nothing. People
 * (the Steckbrief's) never appear: they stay out of the prompt (ADR-0091).
 */

import 'server-only'
import type { Project } from '@/lib/db/schema'
import { isProjectClosed } from '@/lib/projects/project-status'
import { findProjectInOrg, listProjectsInOrg } from '@/lib/projects/repository'
import { rankBySimilarity, sharedTraits, similarityFacts, type SimilarityFacts } from './similarity'

/** How many reference projects the catalog lists; the rest are found with `project_lookup`. */
export const REFERENCE_BRIEF_MAX = 12

/** How long one line's summary may be. */
const SUMMARY_CHARS = 160

function year(day: string | null): string | null {
  return day ? day.slice(0, 4) : null
}

/** „2019–2021", „2019–", or null. */
function periodLabel(project: Pick<Project, 'startedOn' | 'endedOn' | 'closedAt'>): string | null {
  const start = year(project.startedOn)
  const end = year(project.endedOn) ?? (project.closedAt ? String(new Date(project.closedAt).getUTCFullYear()) : null)
  if (start && end) return start === end ? start : `${start}–${end}`
  return end ?? (start ? `${start}–` : null)
}

function factsLabel(facts: SimilarityFacts): string[] {
  return [
    facts.bundesland,
    facts.gebaeudeklasse !== null ? `GK ${facts.gebaeudeklasse}` : null,
    facts.bauweise,
    facts.nutzungen.length > 0 ? facts.nutzungen.join('/') : null,
    facts.vorhabensart,
  ].filter((part): part is string => !!part)
}

function summaryOf(project: Pick<Project, 'profileDisplay'>): string | null {
  const summary = project.profileDisplay?.summary?.replace(/\s+/g, ' ').trim()
  if (!summary) return null
  return summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : summary
}

/** One catalog line: name, id, period, facts, what it shares with the current project, its summary. */
function line(project: Project, current: SimilarityFacts | null): string {
  const facts = similarityFacts(project.profile)
  const head = [periodLabel(project), ...factsLabel(facts)].filter(Boolean).join(', ')
  const shared = current ? sharedTraits(current, facts) : []
  const summary = summaryOf(project)
  return [
    `- ${project.name} (id ${project.id})${head ? `: ${head}` : ''}`,
    shared.length > 0 ? ` · gemeinsam: ${shared.join(', ')}` : '',
    summary ? ` · ${summary}` : '',
  ].join('')
}

/**
 * The catalog for a turn in `current` (null: a chat outside every project), or
 * null when the office has no closed project. Pure; {@link loadReferenceBrief}
 * reads the projects.
 */
export function renderReferenceBrief(current: Project | null, projects: readonly Project[]): string | null {
  const closed = projects.filter((project) => isProjectClosed(project) && project.id !== current?.id)
  if (closed.length === 0) return null
  const ranked = rankBySimilarity(current?.profile ?? null, closed)
  const listed = ranked.slice(0, REFERENCE_BRIEF_MAX)
  const facts = current ? similarityFacts(current.profile) : null
  const lines = listed.map((project) => line(project, facts))
  const more = closed.length - listed.length
  if (more > 0) lines.push(`- … und ${more} weitere abgeschlossene Projekte, über \`project_lookup\` auffindbar.`)
  return lines.join('\n')
}

/** The catalog for a turn: the organization's projects read once, the current one for the order. */
export async function loadReferenceBrief(organizationId: string, projectId: string | null): Promise<string | null> {
  const [projects, current] = await Promise.all([
    listProjectsInOrg(organizationId, { order: 'newest' }),
    projectId ? findProjectInOrg(projectId, organizationId) : Promise.resolve(null),
  ])
  return renderReferenceBrief(current, projects)
}
