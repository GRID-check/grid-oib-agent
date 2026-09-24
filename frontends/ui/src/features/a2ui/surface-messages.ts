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
import { PILOTI_CATALOG_ID, TEXT_COMPONENT } from './catalog'

const CARD_TYPES: ReadonlySet<string> = new Set(
  gridCardSchema.options.map((schema) => {
    const field = schema.shape.type as { value?: string; _def?: { innerType?: { value?: string } } }
    return field.value ?? field._def?.innerType?.value ?? ''
  })
)

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

/**
 * The cards and `Text` leaves a surface holds, in list order — what the
 * fallback stacks when A2UI will not draw the surface. Layout components and
 * anything unknown are left out: an unknown component has nothing to draw.
 */
export function surfaceLeaves(card: GridCard): (GridCard | TextLeaf)[] {
  return surfaceComponents(card).flatMap(({ id: _id, component, ...props }): (GridCard | TextLeaf)[] => {
    if (component === TEXT_COMPONENT && typeof props.text === 'string') return [{ text: props.text }]
    return CARD_TYPES.has(String(component)) ? [{ ...props, type: component } as GridCard] : []
  })
}
