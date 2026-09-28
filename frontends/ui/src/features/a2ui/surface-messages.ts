/**
 * A stored card as the A2UI v0.9 messages that draw it.
 *
 * Every card renders through A2UI (ADR-0065), including every card stored
 * before A2UI was adopted, so the conversion lives here and not on the wire:
 * a lone card is a one-component surface whose root IS the card, and a
 * `surface` card already carries its component list.
 */

import type { A2uiMessage } from '@a2ui/web_core/v0_9'

import type { GridCard } from '@/shared/cards/schemas'
import { gridCardSchema } from '@/shared/cards/schemas'
import { cardTypeOf, PILOTI_CATALOG_ID, SURFACE_EXCLUDED_LEAVES, TEXT_COMPONENT } from './catalog'

const CARD_TYPES: ReadonlySet<string> = new Set(gridCardSchema.options.map(cardTypeOf))

type SurfaceCard = Extract<GridCard, { type: 'surface' }>

/** The component list a card is drawn from. */
export function surfaceComponents(card: GridCard): Record<string, unknown>[] {
  if (card.type === 'surface') return (card as SurfaceCard).components
  const { type, ...props } = card
  return [{ id: 'root', component: type, ...props }]
}

export function cardToSurfaceMessages(card: GridCard, surfaceId: string): A2uiMessage[] {
  return [
    { version: 'v0.9', createSurface: { surfaceId, catalogId: PILOTI_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId, components: surfaceComponents(card) } },
  ] as A2uiMessage[]
}

/** A surface's `Text` leaf: Markdown, not a card. */
export interface TextLeaf {
  text: string
}

/** One leaf of a surface, under the id the surface gave it. */
export interface SurfaceLeaf {
  id: string
  leaf: GridCard | TextLeaf
}

/**
 * The cards and `Text` leaves a surface holds, in list order — what the
 * fallback stacks when A2UI will not draw the surface. Layout components and
 * anything unknown are left out: an unknown component has nothing to draw. So
 * is every leaf the catalog refuses inside a surface
 * (`SURFACE_EXCLUDED_LEAVES`): the fallback is what a refused surface draws,
 * and an interactive card refused there must not come back through it. A card
 * leaf that fails its own schema is dropped too, with a warning as
 * `validateGridCards` leaves: a surface's components are typed as open records,
 * so nothing upstream checked the leaf, and `preflight` refusing it is exactly
 * what sends the surface here. A kept leaf is the parsed card, defaults applied.
 */
export function surfaceLeaves(card: GridCard): SurfaceLeaf[] {
  return surfaceComponents(card).flatMap(({ id, component, ...props }): SurfaceLeaf[] => {
    const leafId = String(id)
    if (component === TEXT_COMPONENT && typeof props.text === 'string') return [{ id: leafId, leaf: { text: props.text } }]
    const type = String(component)
    if (!CARD_TYPES.has(type) || SURFACE_EXCLUDED_LEAVES.has(type)) return []
    const result = gridCardSchema.safeParse({ ...props, type })
    if (result.success) return [{ id: leafId, leaf: result.data }]
    console.warn('[GridCards] Dropping surface leaf that failed schema validation', type, leafId, result.error.issues)
    return []
  })
}
