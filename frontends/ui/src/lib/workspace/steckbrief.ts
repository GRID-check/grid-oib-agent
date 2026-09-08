/**
 * The Steckbrief builder — a project's fingerprint as a bounded prompt block.
 *
 * PURE: no database, no cache, no clock. Everything it needs arrives in the
 * input, so the one property that matters — that the result fits the budget
 * whatever the project looks like — is testable without a fixture, and the
 * CHECK constraint behind it (`project_register_steckbrief_bounded`) is a
 * backstop rather than the only thing that knows the number.
 *
 * **The budget is the point** (spec PR-3). Five Steckbriefe plus the office
 * memory digest ride in one Büro turn's prompt beside everything else it
 * already carries, so 3000 characters is not a guideline that can be exceeded
 * "just this once by a big project": a 200-document project with an 8 KB
 * prompt view must come out at the same ceiling as an empty one.
 *
 * **Truncation is ordered so identity survives.** Each section has its own cap
 * and the caps sum below the budget, so the ordinary path never truncates at
 * all. When something still does not fit — a pathological project name, a
 * profile view that is one enormous line — sections are dropped from the
 * BOTTOM, because the bottom is the inventory and the top is *which project
 * this is*. A Steckbrief that has lost its document list still answers the
 * question the register exists for; one that has lost its name and id answers
 * nothing and cannot even be mounted (spec PR-12).
 *
 * **What is deliberately absent:** a one-line summary per document. Summaries
 * live only in the Python `DocumentMetadataStore` and the application database
 * cannot read them, so the inventory is filename + document class + folder,
 * which is what the BFF actually knows. Spec PR-4 asks for the summary "once
 * document summaries are available to the application database" — until then a
 * guessed summary would be worse than none.
 */

import type { Project } from '@/lib/db/schema'
import { isValidBundeslandToken } from '@/lib/project-profile/intake-definition'
import { ProjectProfileSchema } from '@/lib/project-profile/types'

/** The database invariant, restated here as the builder's own ceiling. */
export const STECKBRIEF_MAX_CHARS = 3000

/**
 * Per-section caps. They sum to well under {@link STECKBRIEF_MAX_CHARS}, which
 * is what makes the drop-a-section loop below a backstop instead of the normal
 * path: an ordinary project is never truncated, only a pathological one is.
 */
const IDENTITY_MAX_CHARS = 300
const PROFILE_MAX_CHARS = 1200
const MEMORY_MAX_CHARS = 600
const DOCUMENTS_MAX_CHARS = 700
/** The inventory is a sample, not a manifest — twenty lines and a count. */
export const STECKBRIEF_MAX_DOCUMENT_LINES = 20

/**
 * Fact keys that mean "where is this project in its life", most specific
 * first. The intake wizard writes `projektphase`; the others are here because
 * a profile may be filled by an agent patch or an older questionnaire and the
 * register's `status` column should hold whichever one the project actually
 * has.
 *
 * A CLOSED list, not a `key.endsWith('status')` guess: `fernwaerme_status` and
 * `errichtungsstatus` are both statuses OF SOMETHING ELSE (the district-heating
 * connection, the building's new-build-vs-existing nature), and rendering
 * "Status: neubau" as the project's status would be a confident wrong answer
 * in the one field an office user scans first.
 */
const STATUS_FACT_KEYS: readonly string[] = [
  'projektstatus',
  'projektphase',
  'planungsphase',
  'leistungsphase',
  'status',
  'phase',
]

export interface SteckbriefDocument {
  filename: string
  /** The human-set classification, which beats every filename guess. */
  docClass: string | null
  /** Materialised folder path, or null for a document at the project root. */
  folderPath: string | null
}

export interface SteckbriefInput {
  project: Pick<Project, 'id' | 'name' | 'profile' | 'profilePromptView' | 'createdAt'>
  /** Top salient active memory rows, already bounded by the caller. */
  memoryHeadline: string | null
  documents: SteckbriefDocument[]
  lastActivityAt: Date | null
}

export interface ProjectSteckbrief {
  text: string
  /** Extracted here so the register column and the prompt block agree. */
  status: string | null
  bundesland: string | null
}

/** One line, whatever the input did: no newline can forge a second field. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Cut to `max` characters on a whole-line boundary where one is available. */
function clampBlock(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  // Only honour a line break that leaves something behind — a first line
  // longer than the cap has no break to fall back to.
  return (lastBreak > max / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()
}

/**
 * The project's status, read out of the profile facts.
 *
 * `projects` has no status column (see the register schema): the Steckbrief
 * needs one and the profile is where the answer lives. Returns null for a
 * project nobody has taken through intake, which is a legitimate and common
 * state, not a failure.
 */
export function readProjectStatusFact(profile: Project['profile']): string | null {
  const parsed = ProjectProfileSchema.safeParse(profile ?? {})
  if (!parsed.success) return null
  for (const key of STATUS_FACT_KEYS) {
    const value = parsed.data.facts[key]?.value
    if (typeof value === 'string' && value.trim()) return oneLine(value)
  }
  return null
}

/**
 * The project's Bundesland, read out of the same profile facts and validated
 * against the intake vocabulary — a stale or hand-edited row must not put an
 * unvalidated jurisdiction token into a prompt block the agent will quote.
 */
export function readProjectBundeslandFact(profile: Project['profile']): string | null {
  const parsed = ProjectProfileSchema.safeParse(profile ?? {})
  if (!parsed.success) return null
  const value = parsed.data.facts.bundesland?.value
  return typeof value === 'string' && isValidBundeslandToken(value) ? value : null
}

function documentInventory(documents: SteckbriefDocument[]): string | null {
  if (documents.length === 0) return null

  const lines: string[] = []
  let used = 0
  for (const document of documents.slice(0, STECKBRIEF_MAX_DOCUMENT_LINES)) {
    const filename = oneLine(document.filename)
    if (!filename) continue
    const line = `- ${filename} · ${oneLine(document.docClass ?? 'unklassifiziert')} · ${oneLine(
      document.folderPath ?? '/'
    )}`
    if (used + line.length + 1 > DOCUMENTS_MAX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return null

  const remaining = documents.length - lines.length
  const header = `dokumente (${documents.length}):`
  // The cap says so in the text the MODEL reads. Without it the agent presents
  // a twenty-line sample as the whole corpus and answers "welche Unterlagen
  // gibt es?" confidently and wrongly.
  const footer = remaining > 0 ? [`… und ${remaining} weitere`] : []
  return [header, ...lines, ...footer].join('\n')
}

/**
 * Build one project's Steckbrief, plus the two facts the register stores as
 * their own columns so recall can filter and render without re-parsing the
 * block it just built.
 */
export function buildProjectSteckbrief(input: SteckbriefInput): ProjectSteckbrief {
  const { project } = input
  const status = readProjectStatusFact(project.profile)
  const bundesland = readProjectBundeslandFact(project.profile)

  // The identity block. Always present, always first, never dropped: it is
  // what lets the agent name the project and mount it (spec PR-12).
  const identity = clampBlock(
    [
      'PROJECT_STECKBRIEF v1',
      `projekt=${oneLine(project.name)}`,
      `id=${project.id}`,
      ...(status ? [`status=${status}`] : []),
      ...(bundesland ? [`bundesland=${bundesland}`] : []),
    ].join('\n'),
    IDENTITY_MAX_CHARS
  )

  // Everything below the identity, in the order it may be dropped from: last
  // first. `profilePromptView` is the view `buildProjectPromptView` already
  // caches for the project chat's own prompt — the same text, so the office
  // and the project never describe one project two ways.
  const promptView = input.project.profilePromptView?.trim()
  const memory = input.memoryHeadline?.trim()
  const inventory = documentInventory(input.documents)
  const sections = [
    promptView ? clampBlock(promptView, PROFILE_MAX_CHARS) : null,
    memory ? `memory:\n${clampBlock(memory, MEMORY_MAX_CHARS)}` : null,
    inventory,
    input.lastActivityAt
      ? `letzte_aktivitaet=${input.lastActivityAt.toISOString().slice(0, 10)}`
      : null,
  ].filter((section): section is string => section !== null)

  return { text: fitSections(identity, sections, STECKBRIEF_MAX_CHARS), status, bundesland }
}

/**
 * Join `identity` and `sections` within `maxChars`, dropping sections from the
 * BOTTOM until it fits and, in the last resort, cutting the identity itself.
 *
 * The per-section caps above already sum below the budget, so for any project
 * this product can produce nothing is dropped here at all. It is exported and
 * tested on its own precisely because of that: "the block fits" has to be a
 * property of the code rather than a property of that arithmetic staying
 * correct after somebody raises one cap, and a guard whose only test is a case
 * that never reaches it is not a guard.
 */
export function fitSections(identity: string, sections: string[], maxChars: number): string {
  const kept = [...sections]
  let text = [identity, ...kept].join('\n\n')
  while (text.length > maxChars && kept.length > 0) {
    kept.pop()
    text = [identity, ...kept].join('\n\n')
  }
  return clampBlock(text, maxChars)
}
