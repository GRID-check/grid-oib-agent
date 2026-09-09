/**
 * The Herleitung, grouped by KNOWLEDGE LEVEL instead of by lane
 * (`workspace-chat-ui.md` §4).
 *
 * A regrouping of what `deriveTraceLanes` already produces — the same lane
 * cards, the same hits, the same citation model. Only the columns' grouping and
 * order change, plus one subgroup per project.
 *
 * ## Why the order is a constant
 *
 * ```
 * law → office → register → project(s) → conversation → web
 * ```
 *
 * `register` sits between office and project because a Steckbrief is an
 * assertion about a project made by the office, not a document from inside one.
 * `conversation` sits after every persistent shelf because a file dropped into
 * this chat is the most local claim there is. `web` is not a knowledge level at
 * all — it is the outside — and sorts last, after everything the organization
 * owns. Extending `STRATUM_ORDER`'s law → office → project with the two new
 * positions, not re-deciding it.
 *
 * ## Every level is always returned
 *
 * Including the empty ones (§3, failure mode 1). A hierarchy the reader can see
 * the HOLE in is the whole reason it is drawn: "Projektregister — nichts
 * eingeblendet" is the fact that stops the Büro being read as "all our
 * projects", and a level that disappears when it finds nothing teaches the
 * reader that the hierarchy is whatever happened.
 *
 * ## This is NOT the LangGraph topology, and must not become one
 *
 * The graph (`shallow_research → clarifier → deep_research`, ADR-0052) answers
 * "which node ran"; it changes when we re-shape the agent. This answers "which
 * knowledge level was read", which is the question the ScopeChip and the
 * ScopeTree already promised the reader an answer to. If the Herleitung's
 * grouping is the graph and the tree's grouping is the hierarchy, the reader
 * has been shown two structures and told they are one thing. Langfuse keeps the
 * graph, for the people who need it.
 */

import type { MemoryContext } from '@/adapters/api/schemas'
import { searchedMemory } from './memory-context'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { CitedDocument } from './citations'
import type { Shelf } from './source-kinds'
import { asSourceKind, kindForLane } from './source-kinds'
import { isMemoryLane, type TraceLaneCard, type TraceSourceHit } from './trace-lanes'

/** The six bands of the Herleitung, in fixed authority order. */
export type KnowledgeLevel =
  | 'law'
  | 'office'
  | 'register'
  | 'project'
  | 'conversation'
  | 'web'

/** Authority-descending, with the outside last. A constant, never a sort. */
export const KNOWLEDGE_LEVEL_ORDER: readonly KnowledgeLevel[] = [
  'law',
  'office',
  'register',
  'project',
  'conversation',
  'web',
] as const

/** `--source-*` family each level paints with (§6 — no new hue for a new level). */
export const LEVEL_SIGNAL: Record<KnowledgeLevel, SourceSignal> = {
  law: 'law',
  office: 'office',
  register: 'project',
  project: 'project',
  conversation: 'project',
  web: 'auto',
}

/** The shelf a level is the reading of. `web` is not a shelf and has none. */
const SHELF_LEVEL: Record<Shelf, KnowledgeLevel> = {
  base: 'law',
  archiv: 'office',
  register: 'register',
  project: 'project',
  session: 'conversation',
}

/** One document/source read at a level. */
export interface LevelEntry {
  /** Raw identity (corpus filename / hostname) — the render key. */
  name: string
  /** Backend display title, when the hit carried one. */
  title?: string
  detail?: string
  /** The lane this hit was found in — the fine label, kept inside the band. */
  laneLabel: string
}

/** One project's hits inside the project level. */
export interface LevelProjectGroup {
  /** Null for a project-shelf hit whose project the wire did not name. */
  projectId: string | null
  projectName: string | null
  entries: LevelEntry[]
}

export interface LevelGroup {
  level: KnowledgeLevel
  signal: SourceSignal
  /** Hits at this level. Zero means the band renders as an honest absence. */
  hitCount: number
  /** Every hit, flat. On `project` these are also split into `projects`. */
  entries: LevelEntry[]
  /** Only ever non-empty on `project`: one subgroup per project, in first-seen order. */
  projects: LevelProjectGroup[]
}

/**
 * The level a hit belongs to.
 *
 * The SHELF first, because it is the fact the backend stated (ADR-0047). It is
 * the only thing that can separate a private session attachment from a project
 * document, so where it exists nothing else is consulted.
 *
 * The LANE is the fallback for a hit that carries no shelf — a web result, an
 * older payload. It is a backend classification (`source_kinds.kind_for_lane`)
 * and not a prefix-match on a collection id, which is what ADR-0047 removed;
 * and it is the same classification the fan prints on the card for that very
 * hit, three rows above this band. A shelf-less Projektwissen hit therefore
 * lands under Projekt here, because the alternative is one panel saying
 * "Projektwissen" and "Projekt — nichts eingeblendet" about one document.
 *
 * `messung` is the one kind that reaches no level: a measurement is about the
 * BUILDING, nothing was read, and there is no shelf it could have come from.
 */
export const levelForHit = (
  hit: Pick<TraceSourceHit, 'shelf'>,
  lane: Pick<TraceLaneCard, 'key' | 'kind'>
): KnowledgeLevel | null => {
  // Memory is not a corpus and reaches NO band here. Without this the lane
  // would fall through `kindForLane`'s fail-open to `web` and a note Piloti
  // wrote would be counted, coloured and tallied as an outside source — the
  // one rendering ADR-0055 forbids outright.
  if (isMemoryLane(lane.key)) return null
  if (hit.shelf) return SHELF_LEVEL[hit.shelf]
  const kind = asSourceKind(lane.kind) ?? kindForLane(lane.key)
  if (kind === 'baurecht') return 'law'
  if (kind === 'web') return 'web'
  if (kind === 'buero') return 'office'
  if (kind === 'projekt') return 'project'
  return null
}

/** Filename/title key a trace hit and a cited document can be matched on. */
const matchKey = (value: string | undefined | null): string =>
  (value ?? '').trim().toLowerCase()

/**
 * Which project a project-shelf hit belongs to.
 *
 * Resolved from the CITED DOCUMENTS, which carry `projectId`/`projectName` as
 * data off the wire (ADR-0054). A trace hit knows its shelf but not its
 * project, and deriving one from the collection id is the guess this codebase
 * keeps refusing to make — so a hit the documents cannot identify stays in the
 * unattributed subgroup rather than being assigned to the likeliest project.
 */
const projectOfHit = (
  hit: TraceSourceHit,
  documents: readonly CitedDocument[]
): { projectId: string | null; projectName: string | null } => {
  const keys = [matchKey(hit.name), matchKey(hit.title)].filter(Boolean)
  const match = documents.find(
    (doc) =>
      doc.projectId &&
      (keys.includes(matchKey(doc.fileName)) || keys.includes(matchKey(doc.title)))
  )
  return match?.projectId
    ? { projectId: match.projectId, projectName: match.projectName ?? null }
    : { projectId: null, projectName: null }
}

const emptyGroup = (level: KnowledgeLevel): LevelGroup => ({
  level,
  signal: LEVEL_SIGNAL[level],
  hitCount: 0,
  entries: [],
  projects: [],
})

/**
 * The six level groups, in order, empty ones included.
 *
 * @param lanes what `deriveTraceLanes` produced for this turn
 * @param documents the turn's cited documents, for project attribution
 */
export const groupByLevel = (
  lanes: readonly TraceLaneCard[],
  documents: readonly CitedDocument[] = []
): LevelGroup[] => {
  const groups = new Map<KnowledgeLevel, LevelGroup>(
    KNOWLEDGE_LEVEL_ORDER.map((level) => [level, emptyGroup(level)])
  )

  for (const lane of lanes) {
    for (const hit of lane.sources) {
      const level = levelForHit(hit, lane)
      if (!level) continue
      const group = groups.get(level)
      if (!group) continue

      const entry: LevelEntry = {
        name: hit.name,
        ...(hit.title ? { title: hit.title } : {}),
        ...(hit.detail ? { detail: hit.detail } : {}),
        laneLabel: lane.label,
      }
      // A document read twice in one turn is one document read; the lanes were
      // already de-duplicated within themselves, this closes the gap across
      // two lanes that both reached the same file.
      if (group.entries.some((existing) => matchKey(existing.name) === matchKey(entry.name))) {
        continue
      }
      group.entries.push(entry)
      group.hitCount += 1

      if (level !== 'project') continue
      const { projectId, projectName } = projectOfHit(hit, documents)
      const bucket = group.projects.find((sub) => sub.projectId === projectId)
      if (bucket) bucket.entries.push(entry)
      else group.projects.push({ projectId, projectName, entries: [entry] })
    }
  }

  return KNOWLEDGE_LEVEL_ORDER.map((level) => groups.get(level) ?? emptyGroup(level))
}


// ---------------------------------------------------------------------------
// The memory band — beside the levels, never one of them (ADR-0055)
// ---------------------------------------------------------------------------

/** One note the turn read, as the memory band renders it. */
export interface MemoryEntry {
  /** Row id — the render key, and what the panel link resolves. */
  id: string
  /** `decision` | `constraint` | `open_question` | `derived_fact` | `preference`. */
  kind: string
  /** The note itself, shown verbatim. */
  content: string
}

/**
 * What the Herleitung says about memory on one turn.
 *
 * Deliberately NOT a {@link LevelGroup}. A level is a shelf that was READ FOR
 * EVIDENCE and every one of them can be opened, quoted and checked; a note is
 * something Piloti wrote down, and putting it in the same list — even last,
 * even grey — would make the band's own promise ("this is where the answer came
 * from") cover a claim nothing can verify. It renders after the levels, under
 * its own heading, with its own sentence saying it is not evidence.
 */
export interface MemoryBand {
  /** Notes the digest carried into this turn, in the order it carried them. */
  entries: MemoryEntry[]
  /** Notes in scope, before the digest's cap. */
  total: number
  /** Notes the digest left out — the number it disclosed to the model. */
  omitted: number
  /** Notes `search_memory` returned this turn; `0` when it was never called. */
  searched: number
  /** Whether the turn reached past the digest at all. */
  searchedMemory: boolean
}

/**
 * The memory band for a turn, or `null` when the turn read no memory at all.
 *
 * `null` and "read nothing" are different facts and stay different: a turn that
 * carried zero notes out of forty still knows the forty exist and says so;
 * a turn with no memory context knows nothing and the band does not render.
 */
export const memoryBand = (context: MemoryContext | undefined): MemoryBand | null =>
  context
    ? {
        entries: context.carried.map((note) => ({
          id: note.id,
          kind: note.kind,
          content: note.content,
        })),
        total: context.total,
        omitted: context.omitted,
        searched: context.searched,
        searchedMemory: searchedMemory(context),
      }
    : null
