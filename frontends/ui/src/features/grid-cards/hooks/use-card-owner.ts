'use client'

import { useChatStore } from '@/features/chat/store'
import type { GridCard } from '@/shared/cards/schemas'
import { findCardOwnerMessageId } from '../card-owner'

/**
 * The message that owns a card set drawn outside a chat bubble, live from the
 * store — see `card-owner.ts` for what "owns" means and why it is not derived
 * from a formula.
 *
 * Selects a STRING, so the subscription is stable no matter how often the
 * conversations array is replaced (every streaming frame replaces it), and a
 * report whose owner has just been loaded from the server picks it up on the
 * next render rather than at the next mount.
 */
export function useCardOwnerMessageId(
  jobId: string | null | undefined,
  cards: readonly GridCard[]
): string | null {
  return useChatStore((state) => findCardOwnerMessageId(state, jobId, cards))
}
