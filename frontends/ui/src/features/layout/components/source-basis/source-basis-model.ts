/**
 * Datenbasis — the pure model behind the composer's source control.
 *
 * ## The reframe
 *
 * The control sets what Piloti MAY consult. The Herleitung reports what it DID.
 * Nothing in here is allowed to phrase itself in the past tense, and nothing in
 * here may report a number the wire does not actually carry.
 *
 * ## Four categories, not a source list
 *
 * This used to show the reader the machinery: an "Immer dabei" section listing
 * the knowledge layer, an "Externe Quellen" section listing whatever
 * `GET /v1/data_sources` happened to return (RIS, Web Search), and a row of
 * preset chips underneath that quietly did something different again. Three
 * controls for one question, in two grammars — an architect had to know what a
 * "data source" is before they could answer "where should Piloti look?".
 *
 * So the reader is offered the four bodies of knowledge they actually think in:
 *
 * | Category | What it stands for |
 * |---|---|
 * | `law`     | RIS (Austrian federal and state law) **and** the OIB guidelines |
 * | `project` | this project's own documents and the current session's uploads |
 * | `office`  | the office archive |
 * | `web`     | the open web |
 *
 * Each category owns both halves of the machinery: the retrieval shelves it
 * opens, and the toggleable data sources whose signal it claims. The reader
 * never meets either word.
 *
 * ## The one thing that is not switchable yet, and why
 *
 * The wire carries a single `source_preset` (`law` | `project` | `office`),
 * which the agent maps to shelves in `shelves_for_turn`. Four independent
 * switches are sixteen combinations; one preset expresses four of them — and
 * they are exactly the four where **law is on**, because every preset includes
 * the `base` shelf:
 *
 * | law | project | office | wire |
 * |---|---|---|---|
 * | on | on  | on  | no preset — the signed scope, intact |
 * | on | on  | off | `project` → `{project, session, base}` |
 * | on | off | on  | `office`  → `{archiv, session, base}` |
 * | on | off | off | `law`     → `{base}` |
 *
 * "Projektunterlagen ohne Baurecht" has no representation on the wire at all.
 * So `law` is modelled as locked on and says so, rather than offering a switch
 * that would silently keep searching the OIB corpus after being turned off. The
 * lock is a statement about today's contract, not a design principle — lifting
 * it needs a new intent field carrying a SET, mapped in `shelves_for_turn` and
 * its twin `includeShelvesForTurn` together. See `backlog.md`.
 *
 * `web` escapes all of this: it is a plain data-source id on the wire, so its
 * switch is real and independent already.
 */

import type { DataSourceFromAPI } from '@/adapters/api'
import { classifySourceSignal, type SourceSignal } from '../../lib/source-presets'
import type { SourcePresetId } from '../../types'

/**
 * What a category is doing right now.
 *
 * `off` and `unavailable` are deliberately different values, because they are
 * different facts: one is a choice the reader made and can unmake, the other is
 * a door that is shut to them. `locked` is a third: on, and not theirs to
 * change — drawn with a chip rather than a disabled switch, because an
 * unflippable switch is a lie about agency.
 */
export type SourceBasisState = 'on' | 'off' | 'unavailable' | 'locked'

/** The four bodies of knowledge the reader chooses between. */
export type SourceCategoryId = 'law' | 'project' | 'office' | 'web'

/**
 * Fixed, authority-descending: law, the reader's own project, their office,
 * then the open web. It never reorders as things are switched — a list that
 * rearranges itself under the pointer stops being readable at a glance.
 */
export const CATEGORY_ORDER: readonly SourceCategoryId[] = ['law', 'project', 'office', 'web']

/** The provenance signal (and therefore tint and glyph) each category wears. */
export const CATEGORY_SIGNAL: Record<SourceCategoryId, SourceSignal> = {
  law: 'law',
  project: 'project',
  office: 'office',
  web: 'auto',
}

export interface SourceCategory {
  id: SourceCategoryId
  name: string
  description: string
  signal: SourceSignal
  state: SourceBasisState
  /** Why this category is on and cannot be switched off. Only set on `locked`. */
  lockedReason?: string
  /** Why this category cannot be used at all. Only set on `unavailable`. */
  unavailableReason?: string
}

/** The wire id the backend knows the knowledge layer by. */
export const KNOWLEDGE_LAYER_ID = 'knowledge_layer'

/** Copy the model needs but must not hard-code (it is locale-dependent). */
export type SourceCategoryLabels = Record<
  SourceCategoryId,
  { name: string; description: string }
> & {
  /** Shown under `law`, in place of the switch it does not get. */
  lawLockedReason: string
  /** Shown on a row the reader cannot use because they are not signed in. */
  signInRequired: string
}

type ClassifiableSource = Pick<
  DataSourceFromAPI,
  'id' | 'name' | 'description' | 'requires_auth'
>

export interface BuildSourceCategoriesInput {
  /** `availableDataSources` from the layout store (knowledge layer already stripped). */
  sources: readonly ClassifiableSource[] | null | undefined
  enabledIds: readonly string[]
  /** The preset currently on the wire — what decides the shelves. */
  activePreset: SourcePresetId | null
  knowledgeLayerAvailable: boolean
  /** Whether the reader holds a token — gates `requires_auth` sources. */
  hasValidToken: boolean
  labels: SourceCategoryLabels
}

/** Which shelf-backed categories a preset leaves in scope. */
const shelfCategoryOn = (
  preset: SourcePresetId | null,
  category: 'project' | 'office'
): boolean => {
  // No preset means the signed collection scope is left intact: everything the
  // caller is allowed to read (ADR-0024). Both shelves are in.
  if (preset === null) return true
  return preset === category
}

/** The sources whose signal a category claims. */
const sourcesForCategory = (
  category: SourceCategoryId,
  sources: readonly ClassifiableSource[]
): ClassifiableSource[] => {
  const signal = CATEGORY_SIGNAL[category]
  return sources.filter(
    (source) => source.id !== KNOWLEDGE_LAYER_ID && classifySourceSignal(source) === signal
  )
}

/**
 * Build the four rows.
 *
 * A category with nothing behind it is omitted rather than drawn dead: with no
 * knowledge layer there is no project shelf to open, and with no web source
 * configured there is no web to search. Offering a switch for either would be
 * offering a choice that does not exist.
 */
export const buildSourceCategories = ({
  sources,
  enabledIds,
  activePreset,
  knowledgeLayerAvailable,
  hasValidToken,
  labels,
}: BuildSourceCategoriesInput): SourceCategory[] => {
  const all = sources ?? []
  const enabled = new Set(enabledIds)

  const row = (id: SourceCategoryId, state: SourceBasisState): SourceCategory => ({
    id,
    name: labels[id].name,
    description: labels[id].description,
    signal: CATEGORY_SIGNAL[id],
    state,
    ...(id === 'law' && state === 'locked' ? { lockedReason: labels.lawLockedReason } : {}),
    ...(state === 'unavailable' ? { unavailableReason: labels.signInRequired } : {}),
  })

  const categories: SourceCategory[] = []

  // Law is always present: the OIB corpus rides the `base` shelf, which exists
  // whether or not RIS is configured as a source.
  categories.push(row('law', 'locked'))

  if (knowledgeLayerAvailable) {
    categories.push(row('project', shelfCategoryOn(activePreset, 'project') ? 'on' : 'off'))
    categories.push(row('office', shelfCategoryOn(activePreset, 'office') ? 'on' : 'off'))
  }

  const webSources = sourcesForCategory('web', all)
  if (webSources.length > 0) {
    const usable = webSources.filter((source) => !source.requires_auth || hasValidToken)
    if (usable.length === 0) {
      categories.push(row('web', 'unavailable'))
    } else {
      categories.push(row('web', usable.some((source) => enabled.has(source.id)) ? 'on' : 'off'))
    }
  }

  return categories
}

/** The reader's answer, as booleans — one per switchable category. */
export interface CategorySelection {
  project: boolean
  office: boolean
  web: boolean
}

/** Read the current selection back off the built rows. */
export const selectionFromCategories = (categories: readonly SourceCategory[]): CategorySelection => {
  const isOn = (id: SourceCategoryId) =>
    categories.some((category) => category.id === id && category.state === 'on')
  return { project: isOn('project'), office: isOn('office'), web: isOn('web') }
}

/**
 * Turn a selection back into what the wire carries.
 *
 * The preset is the shelf half; `enabledIds` is the source half. Law-signal
 * sources (RIS) are enabled unconditionally, which is the same statement the
 * locked `law` row makes on screen. Sources whose signal belongs to a category
 * that is off are dropped, so switching off Büroarchiv also stops an office
 * connector, should one ever be configured.
 */
export const wireForSelection = (
  selection: CategorySelection,
  sources: readonly ClassifiableSource[] | null | undefined
): { preset: SourcePresetId | null; enabledIds: string[] } => {
  const preset: SourcePresetId | null =
    selection.project && selection.office
      ? null
      : selection.project
        ? 'project'
        : selection.office
          ? 'office'
          : 'law'

  const keep = (category: SourceCategoryId): boolean => {
    if (category === 'law') return true
    if (category === 'web') return selection.web
    return selection[category]
  }

  const enabledIds = (sources ?? [])
    .filter((source) => source.id !== KNOWLEDGE_LAYER_ID)
    .filter((source) => {
      const signal = classifySourceSignal(source)
      // `auto` is `classifySourceSignal`'s catch-all, and it is the web
      // category's signal — so anything the classifier does not recognise
      // (news search, prediction markets) rides the web switch. That is the
      // honest place for it: every one of them reaches outside the reader's own
      // documents, which is exactly what that row promises to govern. Nothing
      // is left ungoverned and silently on.
      const category = CATEGORY_ORDER.find((id) => CATEGORY_SIGNAL[id] === signal)
      return category ? keep(category) : true
    })
    .map((source) => source.id)

  return { preset, enabledIds }
}

/**
 * The two shapes the trigger can take. There is no third shape that is just a
 * number: a naked integer is what made the old control unreadable.
 */
export type BasisSummaryKind =
  /** Every category the reader can use is on. */
  | 'all'
  /** A narrower mix — name its categories. */
  | 'subset'

export interface BasisSummary {
  kind: BasisSummaryKind
  /** Categories to name, authority-descending. Capped at `maxCategories`. */
  categories: SourceCategoryId[]
  /** Categories that did not fit — rendered as a `+N` CountPill, never animated. */
  overflow: number
  /**
   * How many bodies of knowledge the next turn may consult. Never rendered as
   * the trigger's label; it exists so the accessible name can be honest.
   */
  consultedCount: number
}

/** How many category words the trigger shows before collapsing into `+N`. */
export const MAX_TRIGGER_CATEGORIES = 2

export const summariseCategories = (
  categories: readonly SourceCategory[],
  maxCategories: number = MAX_TRIGGER_CATEGORIES
): BasisSummary => {
  const usable = categories.filter((category) => category.state !== 'unavailable')
  const on = usable.filter((category) => category.state === 'on' || category.state === 'locked')
  const onIds = CATEGORY_ORDER.filter((id) => on.some((category) => category.id === id))

  if (on.length === usable.length && usable.length > 0) {
    return { kind: 'all', categories: [], overflow: 0, consultedCount: on.length }
  }
  return {
    kind: 'subset',
    categories: onIds.slice(0, maxCategories),
    overflow: Math.max(0, onIds.length - maxCategories),
    consultedCount: on.length,
  }
}
