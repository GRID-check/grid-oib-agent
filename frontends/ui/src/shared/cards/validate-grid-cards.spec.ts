/**
 * @vitest-environment node
 */

/**
 * Why a rejected card leaves a HOLE instead of a gap that closes up.
 *
 * `validateGridCards` preserves wire positions: an item the union does not
 * recognise becomes `undefined` at its own index rather than being filtered
 * out. Positions are card identity — the answer's `[[card:N]]` markers index
 * into exactly this array (`remarkCardMarkers`, and `unplacedCardIndices` for
 * the rest), and interactive-card decisions persist under
 * `cardKey(card, index)` — so closing the gap would move every card after it
 * up one, and each marker downstream of the gap would draw the wrong card,
 * silently, in cards whose own types shipped and work. On reload the same
 * shift would rebind a persisted Accept onto a proposal the user never saw.
 *
 * That is not hypothetical. `diagram` (since retired, ADR-0069) was added to
 * the backend union and to the
 * catalog the model reads while the generated Zod on this side still had no
 * such member, so the first answer to place a `diagram` beside anything else
 * would have re-ordered the rest of its cards — the failure this file exists to
 * keep closed. A hole fails closed instead: a marker pointing at one renders
 * nothing, and a decision whose card became a hole matches nothing and is
 * dropped by `reconcileCardInteractions`.
 *
 * The guard against the general case is cross-stack and lives elsewhere:
 * `tests/aiq_agent/cards/test_interactive_card_parity.py` fails when the
 * backend union carries a type this frontend cannot classify or render. This
 * file pins the CONSEQUENCE, in the frontend's own terms, so the reason the
 * parity guard matters survives next to the code it protects.
 */

import { describe, expect, it, vi } from 'vitest'
import { validateGridCards } from './schemas'

const CALCULATION = {
  type: 'calculation',
  title: 'Schrittmaßregel – Treppenlauf Haus A',
  steps: [
    {
      label: 'Schrittmaß',
      operation: 'sum',
      unit: 'cm',
      operands: [
        { label: 'Steigung', value: 17, unit: 'cm', factor: 2 },
        { label: 'Auftritt', value: 30, unit: 'cm' },
      ],
    },
  ],
  reference: { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2' },
}

const PROPOSAL = { type: 'memory_proposal', title: 'Merken?', content: 'REI 90 bei GK 4.', kind: 'preference' }

const PATCH = {
  type: 'project_profile_patch',
  title: 'Fluchtniveau aktualisieren',
  rationale: 'Das Fluchtniveau liegt bei 25 m.',
  patch: [{ op: 'add', path: '/facts/fluchtniveau', value: '>22m' }],
}

describe('a card the union knows keeps every card after it in place', () => {
  it('validates a calculation rather than dropping it', () => {
    const cards = validateGridCards([CALCULATION])

    expect(cards).toHaveLength(1)
    expect(cards[0]?.type).toBe('calculation')
  })

  it('leaves the cards after a calculation at the index their marker names', () => {
    // `[[card:2]]` means "the second card of this array". If the calculation
    // were dropped the proposal would answer to `[[card:1]]` and the patch to
    // `[[card:2]]` — so the marker the model wrote for its patch would draw a
    // proposal instead, in an answer where nothing looks broken.
    const cards = validateGridCards([CALCULATION, PROPOSAL, PATCH])

    expect(cards.map((card) => card?.type)).toEqual(['calculation', 'memory_proposal', 'project_profile_patch'])
  })
})

describe('a card the union rejects leaves a hole, not a shift', () => {
  it('keeps the wire length and the positions after the gap', () => {
    // The mechanism itself, stated once with a type no build will ever have:
    // the hole is visible to the reader as nothing drawn, and every marker
    // after it still names the card it was written for.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cards = validateGridCards([{ type: 'not_a_card_type' }, PROPOSAL, PATCH])

      expect(cards).toHaveLength(3)
      expect(cards[0]).toBeUndefined()
      expect(cards[1]?.type).toBe('memory_proposal')
      expect(cards[2]?.type).toBe('project_profile_patch')
      // Never in silence — schema drift has to be diagnosable from a console.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('holds the middle when the middle card is the one that fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cards = validateGridCards([PROPOSAL, { type: 'not_a_card_type' }, PATCH])

      expect(cards.map((card) => card?.type)).toEqual(['memory_proposal', undefined, 'project_profile_patch'])
    } finally {
      warn.mockRestore()
    }
  })

  it('returns no cards for a non-array, and holes for nothing else', () => {
    expect(validateGridCards(undefined)).toEqual([])
    expect(validateGridCards(null)).toEqual([])
    expect(validateGridCards({ type: 'memory_proposal' })).toEqual([])
  })
})
