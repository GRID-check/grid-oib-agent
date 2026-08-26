/**
 * @vitest-environment node
 */

/**
 * Why a dropped card is not a missing card — it is a MISPLACED one.
 *
 * `validateGridCards` returns a FILTERED array, and the answer's `[[card:N]]`
 * markers index into exactly that array (`remarkCardMarkers`, and
 * `unplacedCardIndices` for the rest). So a card the union does not recognise
 * does not simply fail to draw: every card after it moves up one, and each
 * marker downstream of the gap draws the wrong card, silently, in cards whose
 * own types shipped and work.
 *
 * That is not hypothetical. `diagram` was added to the backend union and to the
 * catalog the model reads while the generated Zod on this side still had no
 * such member, so the first answer to place a `diagram` beside anything else
 * would have re-ordered the rest of its cards — the failure this file exists to
 * keep closed.
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
    expect(cards[0].type).toBe('diagram')
  })

  it('leaves the cards after a diagram at the index their marker names', () => {
    // `[[card:2]]` means "the second card of this array". If the diagram were
    // dropped the summary would answer to `[[card:1]]` and the callout to
    // `[[card:2]]` — so the marker the model wrote for its Frist would draw a
    // summary instead, in an answer where nothing looks broken.
    const cards = validateGridCards([DIAGRAM, SUMMARY, CALLOUT])

    expect(cards.map((card) => card.type)).toEqual(['diagram', 'summary', 'callout'])
  })

  it('shows what a dropped card does, so the parity guards have a reason', () => {
    // The mechanism itself, stated once with a type no build will ever have:
    // the gap is silent to the reader and closes up underneath the markers.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cards = validateGridCards([{ type: 'not_a_card_type' }, SUMMARY, CALLOUT])

      expect(cards.map((card) => card.type)).toEqual(['summary', 'callout'])
      // Never in silence — schema drift has to be diagnosable from a console.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
