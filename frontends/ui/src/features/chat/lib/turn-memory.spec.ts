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
import { turnMemoryItems, turnMemoryProposals } from './turn-memory'

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


/**
 * The two producers of an OFFER, merged into one (ADR-0055, C6).
 *
 * A reflection pass runs after the answer, when the turn's card registry is
 * already unbound, so an organization-scoped finding it wants to offer arrives
 * on the stage frame instead. What these hold is that this changes nothing the
 * reader can see: one offer, one shape, one decision — and a proposal is still
 * never a write.
 */
describe('proposals from both producers', () => {
  const staged = (content: string) => ({
    memoryReflection: {
      items: [],
      proposals: [
        {
          type: 'memory_proposal' as const,
          title: 'Neue Erkenntnis merken',
          content,
          kind: 'preference' as const,
          confidence: 'medium' as const,
        },
      ],
    },
  })

  it('offers the answer\'s own cards first, then the stage\'s', () => {
    const merged = turnMemoryProposals({
      cards: [proposal('Zwei Stiegenhäuser.')],
      stages: staged('Fluchtwegpläne im Maßstab 1:100.'),
    })
    expect(merged.map((p) => p.origin)).toEqual(['inTurn', 'distillation'])
    expect(merged.map((p) => p.card.content)).toEqual([
      'Zwei Stiegenhäuser.',
      'Fluchtwegpläne im Maßstab 1:100.',
    ])
  })

  it('dedupes rather than stacks — one finding is one offer', () => {
    // The two producers mint ids independently, so only the content can say
    // they are the same offer. The turn's card wins: it was on screen first and
    // it is the one already holding the reader's decision.
    const merged = turnMemoryProposals({
      cards: [proposal('Fluchtwegpläne im Maßstab 1:100.')],
      stages: staged('  fluchtwegpläne  im MASSSTAB 1:100. '.replace('MASSSTAB', 'Maßstab')),
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].origin).toBe('inTurn')
  })

  it('keys a stage proposal outside cardKey\'s namespace', () => {
    // `memory_proposal-3` would collide with the answer's own fourth card the
    // moment the model emits one, and a decision would then be attributed to a
    // card the reader never saw.
    const merged = turnMemoryProposals({ cards: [], stages: staged('Etwas Neues.') })
    expect(merged[0].key).toBe('stage:memory_proposal-0')
    expect(merged[0].key).not.toMatch(/^memory_proposal-\d+$/)
  })

  it('records a stage proposal only once the reader accepted it', () => {
    const stages = staged('Etwas Neues.')
    expect(turnMemoryItems({ stages, cardInteractions: {} })).toEqual([])

    const items = turnMemoryItems({
      stages,
      cardInteractions: {
        'stage:memory_proposal-0': { decision: 'savedOrg', decidedAt: 'x' } as CardInteractions[string],
      },
    })
    expect(items).toEqual([
      {
        id: 'stage:memory_proposal-0',
        kind: 'preference',
        content: 'Etwas Neues.',
        provenance: 'distillation',
      },
    ])
  })

  it('never turns an unanswered proposal into a recorded finding', () => {
    // The rule that keeps the two lists distinct all the way to the reader:
    // rendering an offer as a write would claim a firm-wide note nobody made.
    expect(turnMemoryItems({ stages: staged('Etwas Neues.') })).toEqual([])
  })
})

describe('a correction, carried to the turn that made it', () => {
  const RETIRED = { id: 'row-0', content: 'Das oberste Fluchtniveau beträgt 6,50 m.' }
  const corrected = {
    memoryReflection: {
      items: [
        {
          id: 'row-1',
          kind: 'derived_fact',
          content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
          supersedes: RETIRED,
        },
      ],
    },
  }

  it('hands the notice both notes, so the reader can check the correction', () => {
    // `MemorySupersededNotices` filters on exactly this field and renders both
    // sentences from it. If it stops arriving the notice silently disappears
    // and the correction is once again visible only in the memory panel.
    expect(turnMemoryItems({ stages: corrected })).toEqual([
      {
        id: 'row-1',
        kind: 'derived_fact',
        content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
        provenance: 'distillation',
        supersedes: RETIRED,
      },
    ])
  })

  it('leaves the key off a finding that replaced nothing', () => {
    expect(turnMemoryItems({ stages: reflected })[0]).not.toHaveProperty('supersedes')
  })

  it('never lists the retired note as something this turn recorded', () => {
    // A retired note is not a live one. It is nested under its replacement and
    // must never become an item of its own.
    expect(turnMemoryItems({ stages: corrected }).map((item) => item.id)).toEqual(['row-1'])
  })
})
