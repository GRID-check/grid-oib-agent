/**
 * @vitest-environment node
 */
/**
 * What one turn recorded — and, above all, what it did NOT record
 * (`docs/architecture/post-answer-stages.md` §1.1).
 *
 * Three paths write project memory and only one of them is the post-answer
 * stage. The chip renders two of them and must keep them apart: „während der
 * Antwort notiert" and „nach der Antwort ergänzt" are different promises to the
 * reader, and collapsing them would turn a proposal they answered into
 * something the machine decided on its own, or the reverse.
 *
 * A node-environment spec over a pure module, deliberately: this is the logic,
 * and logic that lives in a render function costs 172ms a case to test instead
 * of one (AGENTS.md).
 */
import { describe, expect, it } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import { turnMemoryItems } from './turn-memory'

const proposal = (content: string): GridCard =>
  ({
    type: 'memory_proposal',
    title: 'Neue Erkenntnis merken',
    content,
    kind: 'constraint',
    confidence: 'high',
  }) as GridCard

const reflected = {
  memoryReflection: {
    items: [
      { id: 'row-1', kind: 'derived_fact', content: 'Das oberste Fluchtniveau beträgt 9,80 m.' },
    ],
  },
}

const answered = (decision: string): CardInteractions => ({
  'memory_proposal-0': { decision, decidedAt: '2026-08-19T10:31:00.000Z' } as CardInteractions[string],
})

describe('turnMemoryItems', () => {
  it('is empty for a turn that recorded nothing', () => {
    // The common case, and the reason the chip renders nothing at all rather
    // than an empty popover.
    expect(turnMemoryItems({})).toEqual([])
    expect(turnMemoryItems({ cards: [proposal('Noch nicht entschieden')] })).toEqual([])
  })

  it('reports what the reflection stage wrote, marked as after the answer', () => {
    expect(turnMemoryItems({ stages: reflected })).toEqual([
      {
        id: 'row-1',
        kind: 'derived_fact',
        content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
        provenance: 'distillation',
      },
    ])
  })

  it('reports an ACCEPTED memory proposal, marked as during the answer', () => {
    const items = turnMemoryItems({
      cards: [proposal('Die Fluchtwegbreite ist mit 1,20 m vorgegeben.')],
      cardInteractions: answered('savedProject'),
    })
    expect(items).toEqual([
      {
        id: 'memory_proposal-0',
        kind: 'constraint',
        content: 'Die Fluchtwegbreite ist mit 1,20 m vorgegeben.',
        provenance: 'inTurn',
      },
    ])
  })

  it('does not claim a proposal the reader dismissed or has not answered', () => {
    // The card's own tool result says it in as many words: "It has NOT been
    // saved yet — do not claim it was saved; the user decides." A chip whose
    // entire job is to say what is now durable about a project may not be the
    // thing that gets that wrong.
    const cards = [proposal('Org-weite Konvention')]
    expect(turnMemoryItems({ cards, cardInteractions: answered('dismissed') })).toEqual([])
    expect(turnMemoryItems({ cards, cardInteractions: {} })).toEqual([])
  })

  it('keeps the two paths apart and in the order they happened', () => {
    // The subtlety this module exists for: three paths surface memory and only
    // one is the stage. The in-turn tool ran while the answer was being
    // written; the stage ran after it was finished.
    const items = turnMemoryItems({
      stages: reflected,
      cards: [proposal('Die Fluchtwegbreite ist mit 1,20 m vorgegeben.')],
      cardInteractions: answered('savedOrg'),
    })
    expect(items.map((item) => item.provenance)).toEqual(['inTurn', 'distillation'])
  })

  it('ignores the other cards of an answer', () => {
    // A `callout` is not a memory, and the fallback block of an answer is full
    // of them.
    const items = turnMemoryItems({
      cards: [{ type: 'callout', kind: 'achtung', title: 'Hanglage', text: 'x' } as GridCard],
      cardInteractions: { 'callout-0': { decision: 'savedOrg', decidedAt: 'x' } as CardInteractions[string] },
    })
    expect(items).toEqual([])
  })
})
