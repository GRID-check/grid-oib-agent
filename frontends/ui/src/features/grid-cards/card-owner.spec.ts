/**
 * Who owns a card set drawn outside a chat bubble.
 *
 * The deep-research report tab draws its cards from a job output, and the
 * decision a reader makes on one of them has to land on the SAME message the
 * thread would record it on — otherwise the same card carries two answers,
 * decided by which panel the reader clicked in. These tests pin the rule that
 * makes the two one fact, and the cases where the honest answer is "no owner".
 */
import { describe, expect, it } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import { findCardOwnerMessageId, type CardOwnerConversation } from './card-owner'

const proposal = (content: string): GridCard =>
  ({
    type: 'memory_proposal',
    title: 'Merken?',
    content,
    kind: 'preference',
    confidence: 'high',
  }) as GridCard

const REPORT_CARDS: GridCard[] = [proposal('REI 90 bei GK4')]

const thread = (
  messages: CardOwnerConversation['messages'],
  id = 'conv-1'
): CardOwnerConversation => ({ id, messages })

describe('findCardOwnerMessageId', () => {
  it('names the message the job wrote its answer to', () => {
    const conversation = thread([
      { id: 'tracking', deepResearchJobId: 'job-1' },
      { id: 'answer', deepResearchJobId: 'job-1', cards: REPORT_CARDS },
    ])

    expect(
      findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', REPORT_CARDS)
    ).toBe('answer')
  })

  it('finds the owner in a thread that is no longer open', () => {
    // The report panel outlives a session switch, so the run on screen may
    // belong to a conversation the reader has since navigated away from.
    const other = thread([{ id: 'answer', deepResearchJobId: 'job-1', cards: REPORT_CARDS }], 'conv-2')

    expect(
      findCardOwnerMessageId(
        { currentConversation: thread([{ id: 'unrelated' }]), conversations: [other] },
        'job-1',
        REPORT_CARDS
      )
    ).toBe('answer')
  })

  it('refuses a message of the same run whose cards are NOT these cards', () => {
    // ADR-0030 §Open Questions: the deep-research tracking bubble can carry its
    // own inline cards from the escalation frame. `cardKey` is positional, so
    // filing the report's `memory_proposal-0` against that message's DIFFERENT
    // `memory_proposal-0` is the mis-attribution the whole rule exists to stop.
    const conversation = thread([
      { id: 'tracking', deepResearchJobId: 'job-1', cards: [proposal('etwas ganz anderes')] },
    ])

    expect(
      findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', REPORT_CARDS)
    ).toBeNull()
  })

  it('refuses a message carrying these cards but belonging to another run', () => {
    const conversation = thread([
      { id: 'other-run', deepResearchJobId: 'job-2', cards: REPORT_CARDS },
    ])

    expect(
      findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', REPORT_CARDS)
    ).toBeNull()
  })

  it('has no owner while the run is still in flight', () => {
    // The answer message is written by the worker when the run finishes; until
    // then the cards are on the wire and nowhere else.
    const conversation = thread([{ id: 'tracking', deepResearchJobId: 'job-1' }])

    expect(
      findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', REPORT_CARDS)
    ).toBeNull()
  })

  it('has no owner without a run to name', () => {
    const conversation = thread([{ id: 'answer', deepResearchJobId: 'job-1', cards: REPORT_CARDS }])

    expect(findCardOwnerMessageId({ currentConversation: conversation }, null, REPORT_CARDS)).toBeNull()
    expect(findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', [])).toBeNull()
  })

  it('survives a store with nothing loaded', () => {
    expect(findCardOwnerMessageId({}, 'job-1', REPORT_CARDS)).toBeNull()
  })

  it('resolves a tie to the later message — the answer, not the tracking bubble', () => {
    const conversation = thread([
      { id: 'tracking', deepResearchJobId: 'job-1', cards: REPORT_CARDS },
      { id: 'answer', deepResearchJobId: 'job-1', cards: REPORT_CARDS },
    ])

    expect(
      findCardOwnerMessageId({ currentConversation: conversation }, 'job-1', REPORT_CARDS)
    ).toBe('answer')
  })

  it('does not search the open conversation twice', () => {
    // `currentConversation` and its entry in `conversations` are separate
    // objects with the same id; the second copy must not shadow the first.
    const conversation = thread([{ id: 'answer', deepResearchJobId: 'job-1', cards: REPORT_CARDS }])

    expect(
      findCardOwnerMessageId(
        { currentConversation: conversation, conversations: [{ ...conversation, messages: [] }] },
        'job-1',
        REPORT_CARDS
      )
    ).toBe('answer')
  })
})
