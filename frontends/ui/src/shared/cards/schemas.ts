// The Grid card schema is generated from the canonical Pydantic models. This
// module re-exports the generated Zod schemas under the stable public API and
// derives the TypeScript types consumed across the app. To change the schema,
// edit `src/aiq_agent/cards/models.py`, regenerate `shared/cards/schemas.json`
// (`uv run python scripts/generate_card_schema.py`), then run
// `npm run generate:cards`.

import { z } from 'zod'
import { gridCardSchema, legalBasisCardSchema, summaryCardSchema, projectProfilePatchCardSchema } from './generated'

export { gridCardSchema, legalBasisCardSchema, summaryCardSchema, projectProfilePatchCardSchema }

export type GridCard = z.infer<typeof gridCardSchema>
export type SummaryCardData = z.infer<typeof summaryCardSchema>
export type LegalBasisCardData = z.infer<typeof legalBasisCardSchema>
export type ProjectProfilePatchCardData = z.infer<typeof projectProfilePatchCardSchema>

/**
 * A message's cards in wire order. An `undefined` hole is a card that failed
 * schema validation and was rejected — the hole keeps its wire index so the
 * positions after it do not move.
 *
 * Positions ARE card identity here: the agent addresses cards from prose as
 * `[[card:N]]` (1-based over this array), and interactive-card decisions are
 * persisted under `cardKey(card, index)`. A validator that filtered rejects
 * would renumber every card after the gap, so the marker the model wrote for
 * one card would draw another — silently, in cards whose own types shipped
 * and work — and a persisted Accept would rebind to a proposal the user never
 * saw on reload. Holes fail closed instead: a marker pointing at one renders
 * nothing (`AgentResponse` skips missing slots, `GridCards` skips missing
 * items), and a decision whose card became a hole matches nothing and is
 * dropped by `reconcileCardInteractions`.
 *
 * Holes are `undefined` in memory and `null` after a JSON round-trip
 * (localStorage, `messages.metadata` jsonb) — every consumer guards with a
 * truthiness check, never `=== undefined`, so both read as "no card here".
 */
export function validateGridCards(raw: unknown): (GridCard | undefined)[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const result = gridCardSchema.safeParse(item)
    if (result.success) {
      return result.data
    }
    // Cards silently vanishing is the worst failure mode here — always leave
    // a trace so schema drift between pydantic and zod is diagnosable. The
    // card is NOT removed (see above): the hole holds its index.
    const cardType =
      typeof item === 'object' && item !== null && 'type' in item ? (item as { type: unknown }).type : 'unknown'
    console.warn('[GridCards] Dropping card that failed schema validation', cardType, result.error.issues)
    return undefined
  })
}
