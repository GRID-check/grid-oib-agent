/**
 * Card decisions — the persisted outcome of a user action on an interactive card.
 *
 * Most cards are pure presentation, but two of them ASK the user something and
 * then mutate server state: `project_profile_patch` (Accept applies a JSON
 * Patch to the project brief) and `memory_proposal` (Yes writes an org- or
 * project-scoped memory). Their answer is part of the conversation's history in
 * exactly the way `promptResponse`/`isPromptResponded` is for a HITL prompt —
 * so it lives on the `ChatMessage`, travels through both persistence layers
 * (localStorage + the `messages.metadata` jsonb), and is replayed on restore.
 *
 * Without this the card re-mounted as `pending` after every reload, offering
 * buttons that would happily apply the same patch or write the same memory a
 * second time (neither endpoint is idempotent).
 *
 * NOT persisted here: transient view state (submit spinner, request error, an
 * open PDF dialog). Those are correctly component-local — they describe an
 * attempt, not a decision.
 */

import type { GridCard } from '@/shared/cards/schemas'

/** Every card type, classified by whether it asks the user to decide something. */
export type CardInteractivity =
  /** Asks the user something and acts on the answer — the answer MUST persist. */
  | 'interactive'
  /** Read-only presentation. Nothing to remember. */
  | 'presentational'

/**
 * ⚠️ ADDING A CARD TYPE? YOU MUST CLASSIFY IT HERE. ⚠️
 *
 * This map is exhaustive over `GridCard['type']`, so the moment
 * `npm run generate:cards` regenerates the union with a new type, `tsc` fails
 * until you add a line here. That failure is deliberate — it is the only
 * checkpoint between "a new card exists" and "its user decisions are durable".
 *
 * If you classify a card as `'interactive'`, the card is NOT done until:
 *   1. its component takes `messageId` + `cardKey` props and drives its
 *      lifecycle from `useCardDecision` — never from local `useState`;
 *   2. `GridCards` passes it both (`messageId={messageId} cardKey={key}`);
 *   3. every terminal outcome it can reach is a member of `CARD_DECISIONS`;
 *   4. `card-interactivity.spec.tsx` covers it (that spec fails for any
 *      `'interactive'` type it does not know how to settle).
 *
 * Classify as `'interactive'` if the card writes anything, anywhere — an API
 * call, a store mutation, a decision the user would be annoyed to repeat.
 * Opening a read-only preview dialog is NOT interactive: it starts no
 * commitment, so there is nothing to remember.
 *
 * See docs/adr/0030-interactive-card-decisions-persist-on-the-message.md.
 */
export const CARD_INTERACTIVITY: Record<GridCard['type'], CardInteractivity> = {
  // Asks the user to apply a JSON Patch to the project brief.
  project_profile_patch: 'interactive',
  // Asks the user to commit an org- or project-scoped memory write.
  memory_proposal: 'interactive',

  // Presentation only — no commitment is started, nothing to remember.
  summary: 'presentational',
  legal_basis: 'presentational',
  requirement_checklist: 'presentational',
  comparison_table: 'presentational',
  document_grid: 'presentational',
  building_section: 'presentational',
  stair_diagram: 'presentational',
  dimension_diagram: 'presentational',
  setback_plan: 'presentational',
  egress_diagram: 'presentational',
  daylight_incidence: 'presentational',
  guardrail_check: 'presentational',
  density_check: 'presentational',
  fire_access_plan: 'presentational',
  acoustic_check: 'presentational',
  fire_compartment: 'presentational',
  thermal_envelope: 'presentational',
  energy_performance: 'presentational',
  elevator_requirement: 'presentational',
  parking_requirement: 'presentational',
  // The 3D model viewer: orbiting, isolating a storey and selecting an element
  // are view state, not decisions — nothing is written and nothing would be
  // annoying to redo, so there is nothing to persist on the message.
  ifc_viewer: 'presentational',
}

/** The card types whose user decisions must be persisted (see the map above). */
export const INTERACTIVE_CARD_TYPES = Object.entries(CARD_INTERACTIVITY)
  .filter(([, kind]) => kind === 'interactive')
  .map(([type]) => type) as Array<GridCard['type']>

export const isInteractiveCardType = (type: GridCard['type']): boolean =>
  CARD_INTERACTIVITY[type] === 'interactive'

/**
 * The terminal outcomes a user can reach on an interactive card. One flat union
 * across card types: each card uses the subset it can produce, and rendering a
 * decision belonging to another card type is impossible because the key is
 * derived from the card itself.
 */
export const CARD_DECISIONS = [
  /** project_profile_patch: the patch was applied to the project brief. */
  'accepted',
  /** project_profile_patch: the user declined the patch. */
  'rejected',
  /** memory_proposal: written org-wide. */
  'savedOrg',
  /** memory_proposal: written scoped to the active project. */
  'savedProject',
  /** memory_proposal: the user declined to remember it. */
  'dismissed',
] as const

export type CardDecision = (typeof CARD_DECISIONS)[number]

/** One recorded decision: what the user chose, and when. */
export interface CardInteraction {
  decision: CardDecision
  /** ISO-8601 instant the decision was recorded (client clock). */
  decidedAt: string
}

/** A message's decisions, keyed by {@link cardKey}. */
export type CardInteractions = Record<string, CardInteraction>

/**
 * Stable identity of a card WITHIN one message.
 *
 * Cards carry no id on the wire, so identity is positional. Once a turn has
 * FINALIZED its `cards` array is never mutated again — it round-trips through
 * localStorage and `metadata.cards` unchanged — so the key means the same thing
 * for the life of the message. `GridCards` uses this same value as its React
 * key, so a decision and the element it belongs to cannot drift apart.
 *
 * While a turn is still STREAMING the array is replaced wholesale on each frame
 * that carries cards; `reconcileCardInteractions` re-checks every recorded
 * decision against the new array on each such replacement.
 */
export const cardKey = (card: Pick<GridCard, 'type'>, index: number): string =>
  `${card.type}-${index}`

const DECISIONS: ReadonlySet<string> = new Set(CARD_DECISIONS)

export const isCardDecision = (value: unknown): value is CardDecision =>
  typeof value === 'string' && DECISIONS.has(value)

/**
 * A UTC ISO-8601 instant, matching what the PATCH route's `.datetime()` takes:
 * `Z`-terminated (no offsets), seconds required, fractional digits optional.
 *
 * Deliberately NOT `value === new Date(value).toISOString()`: that round trip
 * only accepts exactly three fractional digits, so a perfectly valid
 * second-precision instant another client wrote (`…T09:00:00Z`) would be
 * rejected and clobbered to the epoch. `Date.parse` then rejects the values the
 * shape alone lets through (month 15, day 32).
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && UTC_INSTANT.test(value) && !Number.isNaN(Date.parse(value))

/**
 * Drop decisions that no longer refer to the card they were made about.
 *
 * `cardKey` is positional, which is safe once a turn has finalized — but a
 * streaming answer REPLACES `message.cards` wholesale on each frame that
 * carries them, and cards render (and are clickable) while streaming. Without
 * this, a decision made against an in-progress card set could survive into a
 * different card set and describe the wrong card.
 *
 * A decision survives only if the card at its index is BYTE-IDENTICAL to the
 * one that was there before. Same-type-same-index is not enough: two successive
 * frames can both carry a `project_profile_patch` at index 0 proposing
 * different patches, and "accepted" must not carry over to a proposal the user
 * never saw. Anything else is dropped and the card returns to pending — losing
 * a record and re-asking is recoverable, attributing one card's decision to
 * another is not.
 */
export const reconcileCardInteractions = (
  interactions: CardInteractions | undefined,
  previousCards: ReadonlyArray<GridCard> | undefined,
  nextCards: ReadonlyArray<GridCard> | undefined
): CardInteractions | undefined => {
  if (!interactions) return undefined

  // Indices must stay ORIGINAL here — filtering before mapping would renumber
  // them and revive exactly the mis-attribution this guards against.
  const survivors = new Set<string>()
  ;(nextCards ?? []).forEach((card, index) => {
    const previous = previousCards?.[index]
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(card)) {
      survivors.add(cardKey(card, index))
    }
  })

  const kept = Object.entries(interactions).filter(([key]) => survivors.has(key))
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

/**
 * Narrow an untrusted `messages.metadata.cardInteractions` blob to the current
 * shape, dropping anything unrecognised. Applied on the SERVER-rehydrate path
 * (`server-message-mapper.ts`), which is the one that reads JSON this client
 * did not write — another build, another client, a hand-edited row. The
 * localStorage path is not sanitized: it is same-origin state this build wrote.
 *
 * Returns undefined when nothing usable survives, so callers can spread the
 * result without emitting an empty object.
 */
export const sanitizeCardInteractions = (raw: unknown): CardInteractions | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const clean: CardInteractions = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const { decision, decidedAt } = value as { decision?: unknown; decidedAt?: unknown }
    if (!isCardDecision(decision)) continue
    clean[key] = {
      decision,
      // Must emit exactly what the PATCH route accepts. `setCardDecision`
      // re-sends the WHOLE map, so one unparseable timestamp rehydrated from a
      // foreign row would 400 every later decision on that message — and the
      // mirror only warns, so it would fail silently and permanently.
      decidedAt: isTimestamp(decidedAt) ? decidedAt : new Date(0).toISOString(),
    }
  }

  return Object.keys(clean).length > 0 ? clean : undefined
}
