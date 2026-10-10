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
import { flattenIntakeQuestions, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { findProjectInOrg, listProjectsInOrg } from '@/lib/projects/repository'
import { rankBySimilarity, sharedTraits, similarityFacts, type SharedTrait, type SimilarityFacts } from './similarity'

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

/**
 * The wizard's own label for a fact's token („niederoesterreich" →
 * „Niederösterreich"), read off the question that writes the fact, so the
 * catalog says what the reader saw in the intake. A token no option names is
 * shown as it is.
 */
const FACT_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const labels = new Map<string, Map<string, string>>()
  for (const question of flattenIntakeQuestions(projectIntakeDefinitionV1)) {
    const key = /^\/facts\/([a-z_]+)\/value$/.exec(question.writesTo ?? '')?.[1]
    if (!key || !question.options?.length) continue
    const options = labels.get(key) ?? new Map<string, string>()
    for (const option of question.options) options.set(String(option.value).toLocaleLowerCase('de'), option.label)
    labels.set(key, options)
  }
  return labels
})()

function factLabel(key: string, token: string): string {
  return FACT_LABELS.get(key)?.get(token) ?? token
}

function traitLabel(trait: SharedTrait): string {
  return trait.key === 'gebaeudeklasse' ? `GK ${trait.value}` : factLabel(trait.key, trait.value)
}

function factsLabel(facts: SimilarityFacts): string[] {
  const list = (key: string, values: readonly string[]) =>
    values.length > 0 ? values.map((value) => factLabel(key, value)).join('/') : null
  return [
    facts.bundesland ? factLabel('bundesland', facts.bundesland) : null,
    facts.gebaeudeklasse !== null ? `GK ${facts.gebaeudeklasse}` : null,
    list('bauweise', facts.bauweise),
    list('nutzungen', facts.nutzungen),
    facts.vorhabensart ? factLabel('vorhabensart', facts.vorhabensart) : null,
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
    shared.length > 0 ? ` · gemeinsam: ${shared.map(traitLabel).join(', ')}` : '',
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
