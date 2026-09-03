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
 * That is not hypothetical. `diagram` was added to the backend union and to the
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

const DIAGRAM = {
  type: 'diagram',
  title: 'Baubewilligungsverfahren – wer wem was übergibt',
  diagram_type: 'sequence',
  source: 'sequenceDiagram\n  BW->>BB: Einreichunterlagen',
  caption: 'Die Fristen zeigt die Grafik nicht.',
  reference: { document: 'Wiener Bauordnung', section: '§§ 60 ff.' },
}

const SUMMARY = { type: 'summary', title: 'Zusammenfassung', content: 'Kurz gefasst.' }

const CALLOUT = { type: 'callout', kind: 'frist', text: 'Binnen sechs Wochen.' }

describe('a card the union knows keeps every card after it in place', () => {
  it('validates a diagram rather than dropping it', () => {
    const cards = validateGridCards([DIAGRAM])

    expect(cards).toHaveLength(1)
    expect(cards[0]?.type).toBe('diagram')
  })

  it('leaves the cards after a diagram at the index their marker names', () => {
    // `[[card:2]]` means "the second card of this array". If the diagram were
    // dropped the summary would answer to `[[card:1]]` and the callout to
    // `[[card:2]]` — so the marker the model wrote for its Frist would draw a
    // summary instead, in an answer where nothing looks broken.
    const cards = validateGridCards([DIAGRAM, SUMMARY, CALLOUT])

    expect(cards.map((card) => card?.type)).toEqual(['diagram', 'summary', 'callout'])
  })
})

describe('a card the union rejects leaves a hole, not a shift', () => {
  it('keeps the wire length and the positions after the gap', () => {
    // The mechanism itself, stated once with a type no build will ever have:
    // the hole is visible to the reader as nothing drawn, and every marker
    // after it still names the card it was written for.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cards = validateGridCards([{ type: 'not_a_card_type' }, SUMMARY, CALLOUT])

      expect(cards).toHaveLength(3)
      expect(cards[0]).toBeUndefined()
      expect(cards[1]?.type).toBe('summary')
      expect(cards[2]?.type).toBe('callout')
      // Never in silence — schema drift has to be diagnosable from a console.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('holds the middle when the middle card is the one that fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cards = validateGridCards([SUMMARY, { type: 'not_a_card_type' }, CALLOUT])

      expect(cards.map((card) => card?.type)).toEqual(['summary', undefined, 'callout'])
    } finally {
      warn.mockRestore()
    }
  })

  it('returns no cards for a non-array, and holes for nothing else', () => {
    expect(validateGridCards(undefined)).toEqual([])
    expect(validateGridCards(null)).toEqual([])
    expect(validateGridCards({ type: 'summary' })).toEqual([])
  })
})
