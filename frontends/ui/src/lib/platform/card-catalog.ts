/**
 * Platform card catalog — the agent's presentation vocabulary, read from the backend.
 *
 * The card union lives in Pydantic (`src/aiq_agent/cards/models.py`) and every
 * other surface is derived from it (the `emit_card` tool description, the
 * generated Zod schema, the renderers). This service keeps that property for
 * the platform surface too: it READS `GET /v1/platform/cards` rather than
 * re-listing the types here, so a card added to the union appears in the
 * platform view without a second list to forget.
 *
 * Read-only, no tenant data — the payload is the card schema, plus the GitHub
 * feature-request link for a card (or a value on one) Grid cannot render yet.
 */

import 'server-only'
import { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-proxy'
import { UpstreamError } from '@/lib/api/errors'

const CATALOG_TIMEOUT_MS = 10_000

const cardFieldSchema = z.object({
  name: z.string(),
  /** Compact JSON-ish type, e.g. `string`, `[ChecklistItem]`, `"pass" | "fail"`. */
  type: z.string(),
  required: z.boolean(),
  description: z.string(),
  constraints: z.array(z.string()),
})

const cardSchema = z.object({
  type: z.string(),
  model: z.string(),
  summary: z.string(),
  /** `system` cards are emitted by a tool on a sanctioned path, never by the model. */
  emittedBy: z.enum(['agent', 'system']),
  /** `interactive` cards ask the user to authorize a real write (ADR-0030). */
  interaction: z.enum(['presentational', 'interactive']),
  fields: z.array(cardFieldSchema),
  example: z.unknown().nullable(),
})

export const cardCatalogSchema = z.object({
  cards: z.array(cardSchema),
  /** Shapes the card bodies reference by name (NormReference, DimensionCheck, …). */
  buildingBlocks: z.record(z.array(cardFieldSchema)),
  cardCount: z.number(),
  featureRequest: z.object({
    repository: z.string(),
    url: z.string(),
    label: z.string(),
  }),
})

export type CardCatalog = z.infer<typeof cardCatalogSchema>
export type CardCatalogEntry = z.infer<typeof cardSchema>

/** Read the whole card catalog from the backend. Throws {@link UpstreamError}. */
export async function getCardCatalog(): Promise<CardCatalog> {
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/platform/cards`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError(
      'Card catalog backend unreachable',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok) {
    throw new UpstreamError(`Card catalog backend returned ${response.status}`)
  }
  const body = await response.json().catch(() => {
    throw new UpstreamError('Card catalog backend returned malformed JSON')
  })
  const parsed = cardCatalogSchema.safeParse(body)
  if (!parsed.success) {
    // A backend older than this BFF answers a shape this route cannot describe.
    // Failing is right: half a catalog reads as "Grid has no such card", which
    // is exactly the wrong answer to send someone to the issue tracker with.
    throw new UpstreamError('Card catalog backend returned an unexpected shape')
  }
  return parsed.data
}
