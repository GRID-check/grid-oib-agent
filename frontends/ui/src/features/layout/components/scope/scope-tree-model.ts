/**
 * The Wissensbasis, as data — the six knowledge levels in authority order and
 * what each of them is doing on THIS turn (`workspace-chat-ui.md` §4).
 *
 * A pure model rather than logic inside the tree, for the same reason
 * `source-basis-model.ts` is one: the order is fixed, the states are a closed
 * vocabulary, and both are properties worth holding in a millisecond-long test
 * instead of a mount.
 *
 * ## The states are the Datenbasis vocabulary, deliberately
 *
 * `always | on | off | unavailable` are the four words `source-basis-model.ts`
 * already teaches, and they keep their meanings here: `off` is a choice the
 * reader made and can unmake (a source preset narrowed the turn), `unavailable`
 * is a door that is shut (the register outside the Büro, the conversation level
 * with nothing attached). Collapsing the two would make an unflippable switch
 * look like a choice, which is the lie that vocabulary exists to prevent.
 *
 * ## What this model does NOT do
 *
 * It does not toggle. Only two writes exist in this control — mounting and
 * unmounting a project — so no level carries a switch. A control promising
 * retrieval behaviour the backend does not have is the mistake
 * `click-dummy-overhaul-spec.md` §2.3 tells us not to repeat.
 */

import type { SourceSignal } from '../../lib/source-presets'
import type { ConversationScope } from '@/features/chat/lib/project-scope'

/**
 * The six levels, in the fixed authority order the tree renders them in.
 *
 * `memory` sits AFTER `project` and BEFORE `session` (ADR-0055): what Piloti
 * has learned about a project is narrower than the project's documents and
 * wider than one conversation's attachments. It is the one level that is read
 * on EVERY turn, which is precisely why its absence from this list was the
 * hole the tree could not show.
 */
export type ScopeLevelId = 'base' | 'archiv' | 'register' | 'project' | 'memory' | 'session'

/** Same four words the Datenbasis uses — see the module header. */
export type ScopeLevelState = 'on' | 'off' | 'unavailable' | 'always'

/**
 * What the memory level states: carried out of total, with the omission the
 * digest already disclosed to the model.
 */
export interface MemoryLevelCounts {
  /** Notes the digest actually carried into this turn. */
  carried: number
  /** Notes in scope, before the digest's cap. */
  total: number
  /** Notes the digest left out — `total - carried` as the backend counted it. */
  omitted: number
}

/** One project this conversation may read, as the tree renders it. */
export interface MountedProject {
  projectId: string
  projectName: string
  /** Who put it in view. The tree says so; the notice in the transcript says why. */
  mountedBy?: 'user' | 'agent'
}

export interface ScopeLevel {
  id: ScopeLevelId
  state: ScopeLevelState
  /** `--source-*` family this level paints with (§6 — no new hue for a new level). */
  signal: SourceSignal
  /**
   * Why this level is `off` or `unavailable`, as a dictionary key plus its
   * values. Never a rendered sentence: the model is locale-free, and a reason
   * is REQUIRED on both of those states — a row that cannot be switched and
   * does not say why is the shape this design is written against.
   */
  reason?: { key: string; values?: Record<string, string> }
  /** Only ever set on `project`: the projects in view, in mount order. */
  mounted?: MountedProject[]
  /**
   * Only ever set on `memory`: what THIS turn's digest carried, out of how
   * many notes exist, and how many it had to leave out.
   *
   * The omission count is the same number the digest text discloses to the
   * model (ADR-0055): what the model is told and what the reader is told must
   * not diverge, and this level exists because they did.
   */
  memory?: MemoryLevelCounts
  /**
   * Only on `project`, and only in a project chat: the one project this chat is
   * locked to. Distinct from `mounted`, which is the Büro's growable list.
   */
  lockedProjectName?: string
  /** Whether this level offers "+ Projekt einblenden" (the Büro's project level). */
  canMount?: boolean
}

export interface BuildScopeLevelsInput {
  /** Which surface the tree is standing on. */
  scope: ConversationScope
  /** The project a project chat is locked to. */
  projectName?: string | null
  /** Projects in view. Always empty in a project chat. */
  mounted?: readonly MountedProject[]
  /** Files attached to THIS conversation — the conversation level's evidence. */
  sessionAttachmentCount?: number
  /**
   * The source preset the reader picked, if any, and which levels it excludes.
   * The "Büroarchiv" preset genuinely turns Projektwissen off, so `off` is a
   * real state rather than a theoretical one — and the row that wears it names
   * the preset that caused it.
   */
  preset?: { label: string; excludes: readonly ScopeLevelId[] } | null
  /** Whether the reader may still mount (the cap is not reached). */
  canMount?: boolean
  /**
   * What the last answered turn read out of memory, when one has been answered.
   * `null`/absent means "not known yet", which is NOT the same as zero: the
   * level still renders `always`, it just states no counts.
   */
  memory?: MemoryLevelCounts | null
  /**
   * Whether this tenant has organization-scoped memory at all. Only consulted
   * OUTSIDE a project, where organization notes are the only ones in scope —
   * without them the level is a door that is shut, and says so.
   */
  hasOrganizationMemory?: boolean
}

/** Which `--source-*` family each level paints with (§6). */
const LEVEL_SIGNAL: Record<ScopeLevelId, SourceSignal> = {
  base: 'law',
  archiv: 'office',
  // Memory takes `--source-auto` GREY, the one family that is not a corpus.
  // It is not evidence and must never be paintable as any tier of it: what a
  // note states was never retrieved from a document that could be opened.
  memory: 'auto',
  // The register, the projects and the conversation are ALL the project family:
  // a Steckbrief is not a different tier of trust from a project document, only
  // a coarser grain of the same one. The glyph carries the distinction.
  register: 'project',
  project: 'project',
  session: 'project',
}

/**
 * The tree, top to bottom.
 *
 * The order is a constant and not a sort: the hierarchy is fixed, and the whole
 * point of a fixed hierarchy is that the reader can see the hole in it.
 */
export const buildScopeLevels = ({
  scope,
  projectName,
  mounted = [],
  sessionAttachmentCount = 0,
  preset = null,
  canMount = true,
  memory = null,
  hasOrganizationMemory = true,
}: BuildScopeLevelsInput): ScopeLevel[] => {
  const isWorkspace = scope === 'workspace'
  const excluded = (id: ScopeLevelId): boolean => (preset?.excludes ?? []).includes(id)
  const presetReason = { key: 'workspace.tree.offByPreset', values: { preset: preset?.label ?? '' } }

  const level = (id: ScopeLevelId, state: ScopeLevelState, extra: Partial<ScopeLevel> = {}): ScopeLevel => ({
    id,
    state,
    signal: LEVEL_SIGNAL[id],
    ...extra,
  })

  const levels: ScopeLevel[] = []

  levels.push(
    excluded('base')
      ? level('base', 'off', { reason: presetReason })
      : level('base', 'always')
  )
  levels.push(
    excluded('archiv')
      ? level('archiv', 'off', { reason: presetReason })
      : level('archiv', 'always')
  )

  // The register exists only in the Büro. Outside it the row is `unavailable`
  // with the reason, not absent: a level that disappears teaches the reader
  // that the hierarchy is whatever happened.
  levels.push(
    isWorkspace
      ? level('register', 'always')
      : level('register', 'unavailable', { reason: { key: 'workspace.tree.registerOutsideWorkspace' } })
  )

  if (isWorkspace) {
    const state: ScopeLevelState = excluded('project')
      ? 'off'
      : mounted.length > 0
        ? 'on'
        : 'off'
    levels.push(
      level('project', state, {
        mounted: [...mounted],
        canMount,
        // Two different `off`s, and they must not read alike: a preset excluded
        // the level, or simply nothing is in view yet. Only the first is a
        // reason, and only the first has somewhere to go back to.
        ...(excluded('project') ? { reason: presetReason } : {}),
      })
    )
  } else {
    levels.push(
      excluded('project')
        ? level('project', 'off', { reason: presetReason, lockedProjectName: projectName ?? undefined })
        : level('project', 'always', { lockedProjectName: projectName ?? undefined })
    )
  }

  // Memory. It has no `off`: the reader cannot switch it off from HERE, because
  // the place a note is removed is the memory panel, and a switch here would
  // promise a per-turn exclusion the backend does not have. A preset narrows
  // which CORPORA are read and says nothing about what Piloti has learned, so
  // no preset reaches this row either.
  levels.push(
    isWorkspace && !hasOrganizationMemory
      ? level('memory', 'unavailable', { reason: { key: 'workspace.tree.memoryNoOrganization' } })
      : level('memory', 'always', { ...(memory ? { memory } : {}) })
  )

  levels.push(
    sessionAttachmentCount > 0
      ? level('session', excluded('session') ? 'off' : 'always', {
          ...(excluded('session') ? { reason: presetReason } : {}),
        })
      : level('session', 'unavailable', { reason: { key: 'workspace.tree.sessionEmpty' } })
  )

  return levels
}

/** The memory level, for a caller that only wants the Gedächtnis half. */
export const memoryLevel = (levels: readonly ScopeLevel[]): ScopeLevel | undefined =>
  levels.find((entry) => entry.id === 'memory')

/** The project level, for a caller that only wants the mounting half. */
export const projectLevel = (levels: readonly ScopeLevel[]): ScopeLevel | undefined =>
  levels.find((entry) => entry.id === 'project')
