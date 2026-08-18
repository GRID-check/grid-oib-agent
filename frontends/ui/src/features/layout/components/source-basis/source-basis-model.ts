/**
 * Datenbasis — the pure model behind the composer's source control.
 *
 * ## The reframe
 *
 * The control sets what Piloti MAY consult. The Herleitung reports what it DID.
 * Nothing in here is allowed to phrase itself in the past tense, and nothing in
 * here may report a number the wire does not actually carry.
 *
 * ## Why this module exists at all
 *
 * The composer used to render a naked integer taken from `enabledDataSourceIds`.
 * That number was wrong in two directions at once:
 *
 * 1. `knowledge_layer` is stripped out of `availableDataSources` by
 *    `adapters/api/data-sources-client.ts`, so it can never be counted — while
 *    `use-websocket-chat.ts` unconditionally appends it to every turn's
 *    `dataSourcesForMessage`. The pill said "2" while three things went out, and
 *    the two it omitted (Projektwissen, Büroarchiv) are exactly the ones an
 *    architect cares about.
 * 2. `computePresetSourceIds('office', …)` legitimately returns `[]` (the office
 *    archive is retrieved through the knowledge layer, not through a toggleable
 *    source), so picking the **Büroarchiv** preset made the composer report
 *    "Datengrundlage 0" — zero sources, right after the user named one.
 *
 * Both bugs are fixed here, once: the knowledge layer is folded in as `always`
 * entries so the invisible participant is finally represented, and the trigger
 * summary is a *shape* (a named preset, a set of strata) rather than a count.
 */

import type { DataSourceFromAPI } from '@/adapters/api'
import { classifySourceSignal, type SourceSignal } from '../../lib/source-presets'
import type { SourcePresetId } from '../../types'

/**
 * What a single entry in the Datenbasis is doing right now.
 *
 * `off` and `unavailable` are deliberately different values, because they are
 * different facts: one is a choice the reader made and can unmake, the other is
 * a door that is shut to them. The old picker painted both as `opacity-50` plus
 * an unchecked Switch — an unflippable switch is a lie about agency.
 */
export type SourceBasisState = 'on' | 'off' | 'unavailable' | 'always'

export interface SourceBasisEntry {
  /** Stable id. Knowledge-layer entries use the `knowledge_layer:*` namespace. */
  id: string
  name: string
  description: string
  signal: SourceSignal
  state: SourceBasisState
  /** Why this entry cannot be switched — only ever set on `unavailable`. */
  unavailableReason?: string
}

/** The wire id the backend knows the knowledge layer by. */
export const KNOWLEDGE_LAYER_ID = 'knowledge_layer'
/** Synthetic ids for the two strata the knowledge layer actually carries. */
export const KNOWLEDGE_PROJECT_ID = 'knowledge_layer:project'
export const KNOWLEDGE_OFFICE_ID = 'knowledge_layer:office'

/**
 * Authority-descending stratum order — law, then office, then project, then
 * whatever the open web turned up. It is fixed on purpose: the trigger must not
 * reorder itself as the reader toggles things, or the row stops being readable
 * at a glance.
 */
export const STRATUM_ORDER: readonly SourceSignal[] = ['law', 'office', 'project', 'auto']

const strataIndex = (signal: SourceSignal): number => {
  const index = STRATUM_ORDER.indexOf(signal)
  return index === -1 ? STRATUM_ORDER.length : index
}

/** Copy the model needs but must not hard-code (it is locale-dependent). */
export interface SourceBasisLabels {
  projectName: string
  projectDescription: string
  officeName: string
  officeDescription: string
  /** Shown as the visible reason on a row the reader cannot switch. */
  signInRequired: string
}

export interface BuildSourceBasisInput {
  /** `availableDataSources` from the layout store (knowledge layer already stripped). */
  sources: readonly Pick<DataSourceFromAPI, 'id' | 'name' | 'description' | 'requires_auth'>[] | null | undefined
  enabledIds: readonly string[]
  knowledgeLayerAvailable: boolean
  /** Whether the reader holds a token — gates `requires_auth` sources. */
  hasValidToken: boolean
  labels: SourceBasisLabels
}

export interface SourceBasis {
  /** Non-interactive entries: the knowledge layer, which is always in scope. */
  always: SourceBasisEntry[]
  /** Toggleable entries, authority-descending, web search last. */
  external: SourceBasisEntry[]
}

/**
 * Build the full Datenbasis.
 *
 * The knowledge layer is not a toggleable data source — it is appended to every
 * turn — so it is modelled as two `always` entries rather than hidden. It is
 * split into Projektwissen and Büroarchiv because those are two different
 * provenance strata to the reader even though they ride one wire id.
 */
export const buildSourceBasis = ({
  sources,
  enabledIds,
  knowledgeLayerAvailable,
  hasValidToken,
  labels,
}: BuildSourceBasisInput): SourceBasis => {
  const enabled = new Set(enabledIds)

  const always: SourceBasisEntry[] = knowledgeLayerAvailable
    ? [
        {
          id: KNOWLEDGE_PROJECT_ID,
          name: labels.projectName,
          description: labels.projectDescription,
          signal: 'project',
          state: 'always',
        },
        {
          id: KNOWLEDGE_OFFICE_ID,
          name: labels.officeName,
          description: labels.officeDescription,
          signal: 'office',
          state: 'always',
        },
      ]
    : []

  const external: SourceBasisEntry[] = (sources ?? [])
    .filter((source) => source.id !== KNOWLEDGE_LAYER_ID)
    .map((source) => {
      const available = !source.requires_auth || hasValidToken
      const state: SourceBasisState = !available ? 'unavailable' : enabled.has(source.id) ? 'on' : 'off'
      return {
        id: source.id,
        name: source.name,
        description: source.description ?? '',
        signal: classifySourceSignal(source),
        state,
        ...(available ? {} : { unavailableReason: labels.signInRequired }),
      }
    })
    .sort((a, b) => strataIndex(a.signal) - strataIndex(b.signal) || a.name.localeCompare(b.name))

  return { always, external }
}

/**
 * The four shapes the trigger can take. There is no fifth shape that is just a
 * number: a naked integer is what made the old control unreadable.
 */
export type BasisSummaryKind =
  /** A preset is active — say its name, even when it selects no external source. */
  | 'preset'
  /** Every external source the reader can use is on. */
  | 'all'
  /** No external source is on; only the always-on knowledge layer remains. */
  | 'internalOnly'
  /** A hand-picked mix — name its strata. */
  | 'subset'

export interface BasisSummary {
  kind: BasisSummaryKind
  /** Set iff `kind === 'preset'`. */
  preset?: SourcePresetId
  /** Strata to name, authority-descending. Capped at `maxStrata` for `subset`. */
  strata: SourceSignal[]
  /** Strata that did not fit — rendered as a `+N` CountPill, never animated. */
  overflow: number
  /**
   * How many things the next turn may actually consult, knowledge layer
   * included. Never rendered as the trigger's label; it exists so the
   * accessible name can be honest.
   */
  consultedCount: number
}

/** How many stratum words the trigger shows before collapsing into `+N`. */
export const MAX_TRIGGER_STRATA = 2

/**
 * Summarise a basis for the trigger.
 *
 * Ordering of the checks is itself a decision: an active preset wins over
 * "everything is on", because the preset's own name ("Büroarchiv") is the more
 * precise of two true statements — and because the office preset enables no
 * external source at all, so without this branch it would fall through to
 * `internalOnly` and the reader would be told they picked nothing.
 */
export const summariseBasis = (
  basis: SourceBasis,
  activePreset: SourcePresetId | null,
  maxStrata: number = MAX_TRIGGER_STRATA
): BasisSummary => {
  const selectable = basis.external.filter((entry) => entry.state !== 'unavailable')
  const on = selectable.filter((entry) => entry.state === 'on')
  const consultedCount = on.length + basis.always.length

  const strataOn = STRATUM_ORDER.filter((signal) => on.some((entry) => entry.signal === signal))

  if (activePreset) {
    return { kind: 'preset', preset: activePreset, strata: [], overflow: 0, consultedCount }
  }
  if (on.length === 0) {
    return { kind: 'internalOnly', strata: [], overflow: 0, consultedCount }
  }
  if (on.length === selectable.length) {
    return { kind: 'all', strata: [], overflow: 0, consultedCount }
  }
  return {
    kind: 'subset',
    strata: strataOn.slice(0, maxStrata),
    overflow: Math.max(0, strataOn.length - maxStrata),
    consultedCount,
  }
}

/**
 * True when the reader has switched off every external source they could use.
 * The composer's `NoSourcesBanner` cannot say this — it short-circuits on
 * `knowledgeLayerAvailable`, so with the knowledge layer present the case is
 * completely silent today.
 */
export const hasNoExternalSources = (basis: SourceBasis): boolean => {
  const selectable = basis.external.filter((entry) => entry.state !== 'unavailable')
  return selectable.length > 0 && selectable.every((entry) => entry.state === 'off')
}
