/**
 * The Grid output-card catalogue, derived from the generated Zod schemas.
 *
 * A skill author picks card types here (`grid-cards`), so the list has to be
 * the SAME list the agent is allowed to emit. It is therefore read out of
 * `shared/cards/generated.ts` — which is regenerated from the canonical Pydantic
 * models — rather than typed out by hand: a hand-kept copy drifts the moment
 * someone adds a card, and the drift is silent (the picker simply stops
 * offering the new card, or offers one the backend rejects at write time).
 *
 * Two things are dropped on the way out, mirroring
 * `aiq_agent.cards.catalog.model_facing_card_types()`:
 *
 *  - SYSTEM cards, which a tool emits on a sanctioned path. They are valid union
 *    members (they must render), but the model is never told they exist, so an
 *    author must not be able to ask for one either.
 *  - everything after the first paragraph of a schema's `.describe()` text. The
 *    longer descriptions are model-facing emission guidance ("Emit when …");
 *    a picker row wants the one sentence that says what the card IS.
 */

import { gridCardSchema } from '@/shared/cards/schemas'

/**
 * Card types emitted only by a tool, never by the model.
 *
 * Kept in sync with `SYSTEM_CARD_TYPES` in `src/aiq_agent/cards/catalog.py`.
 * This is a two-name denylist rather than a derived value because nothing in the
 * generated Zod schemas records the distinction — and unlike the card list
 * itself, it does not grow every time a card is added. `card-catalog.spec.ts`
 * asserts both names still resolve to real union members, so removing a system
 * card upstream fails here instead of leaving a dead entry behind.
 */
export const SYSTEM_CARD_TYPES = ['memory_proposal', 'document_grid'] as const

export interface CardCatalogEntry {
  /** The card's `type` literal — what is stored in `grid-cards`. */
  type: string
  /** One-line human description, taken from the schema's own `.describe()`. */
  description: string
}

/** First paragraph of a schema description, collapsed onto one line. */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/, 1)[0].replace(/\s+/g, ' ').trim()
}

function buildCardCatalog(): CardCatalogEntry[] {
  const system = new Set<string>(SYSTEM_CARD_TYPES)
  const entries: CardCatalogEntry[] = []
  // `optionsMap` is keyed by the discriminator value zod itself resolved, so it
  // is correct even for the one card whose `type` literal is wrapped in a
  // `.default()` (project_profile_patch) — unwrapping `_def` by hand is not.
  for (const [type, option] of gridCardSchema.optionsMap) {
    if (typeof type !== 'string' || system.has(type)) continue
    entries.push({ type, description: firstParagraph(option.description ?? '') })
  }
  return entries
}

/** Every card type an author may name, in the union's declaration order. */
export const CARD_CATALOG: readonly CardCatalogEntry[] = buildCardCatalog()

const CARD_TYPE_SET = new Set(CARD_CATALOG.map((entry) => entry.type))

/** Whether `type` is a card an author (and therefore the agent) may ask for. */
export function isSelectableCardType(type: string): boolean {
  return CARD_TYPE_SET.has(type)
}

/**
 * Read a stored `grid-cards` value: trimmed, deduplicated, author order kept,
 * and filtered to cards the catalogue still offers.
 *
 * Lives here rather than beside the metadata key so the editor (a client
 * component) and the write boundary parse the value the same way without the
 * editor having to import the server-side skills module.
 */
export function parsePreferredCardTypes(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const type = part.trim()
    if (type && isSelectableCardType(type)) seen.add(type)
  }
  return [...seen]
}

/** The stored form of a selection — the inverse of `parsePreferredCardTypes`. */
export function formatPreferredCardTypes(types: readonly string[]): string {
  return types.join(',')
}

/**
 * Catalogue entries matching a free-text query, in catalogue order.
 *
 * Matches the card type AND its description, because an author looking for the
 * right card knows what they want to show ("escape route"), not what the union
 * happens to call it (`egress_diagram`).
 */
export function searchCardCatalog(query: string): readonly CardCatalogEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return CARD_CATALOG
  return CARD_CATALOG.filter(
    (entry) =>
      entry.type.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle)
  )
}
