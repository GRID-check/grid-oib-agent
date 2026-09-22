/**
 * A RETIRED card type keeps rendering. That is the whole point of retiring one.
 *
 * `follow_ups` is now a member of `SYSTEM_CARD_TYPES` in
 * `src/aiq_agent/cards/catalog.py`, so the model cannot emit a new one on any of
 * the three backend emission paths. The cards already written into
 * `messages.metadata.cards` are a different matter: they are re-validated on
 * every render (`server-message-mapper.ts` -> `validateGridCards`) and drawn by
 * `GridCardItem`, and there are thousands of them across historical threads.
 *
 * The alternative to retiring — deleting the union member — is the move this
 * suite exists to make impossible to ship silently. `validateGridCards` leaves
 * an `undefined` hole for anything that fails the union and logs a warning per
 * card, so removing the member would cost every old thread its chips AND fill
 * the console with one line per lost card, while every backend test about "the
 * model can no longer emit one" carried on passing. Nothing else in the
 * frontend would notice: the type would simply stop existing.
 *
 * So the assertions here are deliberately about the READ path, from the shape a
 * database row actually holds to pixels, and they are pinned on the frontend
 * side because that is where the loss would happen.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@/lib/db/schema'
import { render, screen } from '@/test-utils'
import { validateGridCards } from '@/shared/cards/schemas'
import { mapServerMessageToChatMessage } from '@/features/chat/lib/server-message-mapper'
import { CARD_INTERACTIVITY } from './card-decision'
import { GridCardItem } from './components/GridCards'

/** A stored card, in the shape `metadata.cards` holds it. */
const STORED_FOLLOW_UPS = {
  type: 'follow_ups',
  title: 'Weiterführende Fragen',
  items: [
    { question: 'Wie wird das Fluchtniveau gemessen?', hint: 'Messpunkt und Bezugsebene' },
    { question: 'Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?' },
  ],
}

const storedMessage = (cards: unknown[]): Message =>
  ({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    conversationId: 's_conv_1',
    role: 'assistant',
    content: 'Die Gebäudeklasse ergibt sich aus dem Fluchtniveau.',
    metadata: { messageType: 'agent_response', cards },
    createdAt: '2026-07-01T10:00:00.000Z' as unknown as Date,
  }) as Message

describe('the retired follow_ups card', () => {
  it('still passes the union, so a stored one is not holed', () => {
    const validated = validateGridCards([STORED_FOLLOW_UPS])

    expect(validated).toHaveLength(1)
    expect(validated[0]?.type).toBe('follow_ups')
  })

  it('survives the read path off a stored message row', () => {
    const mapped = mapServerMessageToChatMessage(storedMessage([STORED_FOLLOW_UPS]))

    expect(mapped!.cards).toHaveLength(1)
    expect(mapped!.cards![0]).toMatchObject({ type: 'follow_ups', title: 'Weiterführende Fragen' })
  })

  it('is not dropped with a warning, which is how the loss would actually look', () => {
    // `validateGridCards` never throws — it leaves a hole and warns. So a
    // union member removed by a future change would show up here and nowhere
    // else.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      validateGridCards([STORED_FOLLOW_UPS])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('still draws its chips', () => {
    const [card] = validateGridCards([STORED_FOLLOW_UPS])
    expect(card).toBeDefined()
    if (!card) throw new Error('expected the retired follow_ups card to validate')
    render(<GridCardItem card={card} index={0} projectId={null} />)

    expect(screen.getByText('Wie wird das Fluchtniveau gemessen?')).toBeInTheDocument()
    expect(
      screen.getByText('Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?')
    ).toBeInTheDocument()
  })

  it('keeps its interactivity classification, so the exhaustive map still compiles', () => {
    // `CARD_INTERACTIVITY` is exhaustive over the union — `tsc` fails on a
    // missing key. Retiring a type must not quietly take its entry with it,
    // because a stored card's renderer reads this to decide whether it owns a
    // decision. Chips prefill the composer and persist nothing.
    expect(CARD_INTERACTIVITY.follow_ups).toBe('presentational')
  })
})
