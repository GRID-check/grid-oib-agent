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

export function validateGridCards(raw: unknown): GridCard[] {
  if (!Array.isArray(raw)) return []
  const validated: GridCard[] = []
  for (const item of raw) {
    const result = gridCardSchema.safeParse(item)
    if (result.success) {
      validated.push(result.data)
    } else {
      // Cards silently vanishing is the worst failure mode here — always leave
      // a trace so schema drift between pydantic and zod is diagnosable.
      const cardType =
        typeof item === 'object' && item !== null && 'type' in item ? (item as { type: unknown }).type : 'unknown'
      console.warn('[GridCards] Dropping card that failed schema validation', cardType, result.error.issues)
    }
  }
  return validated
}
