/**
 * Render tests for `legal_basis` — the card an architect verifies.
 *
 * Both fields under test are new on the wire and exist for one reason each:
 * `lane` so the OIB-vs-RIS accent is DATA rather than a regex over the law
 * name, and `edition` so the citation says which Ausgabe was read. The
 * assertions are therefore about provenance, not about layout: which tier the
 * card claims, where that claim comes from, and what it does when the wire says
 * nothing.
 *
 * Lives at the feature root next to `preview-fixtures.spec.ts` rather than in
 * `components/`, which another sprint owns.
 */

import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { LegalBasisCard } from './components/LegalBasisCard'
import { LEGAL_BASIS_STATUTE, previewFixtureFor } from './preview-fixtures'

// The corpus list is a session-cached `fetch`, which jsdom has no server for.
// An empty list is the honest default: no in-app PDF, external link only.
vi.mock('@/features/knowledge/lib/use-corpus-files', () => ({
  useCorpusFiles: () => [],
}))

/** The reader is Austrian; the copy comes from the German dictionary. */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

/** Every wire field, so a test can vary exactly the one it is about. */
const card = (overrides: Partial<Parameters<typeof LegalBasisCard>[0]> = {}) => ({
  type: 'legal_basis' as const,
  law: 'OIB-Richtlinie 2',
  lane: null,
  edition: null,
  article: null,
  section: null,
  summary: null,
  original_text: null,
  ...overrides,
})

const accentOf = (container: HTMLElement) => (container.firstElementChild as HTMLElement).className

describe('LegalBasisCard provenance accent', () => {
  it('paints the OIB accent when the lane says OIB', () => {
    const { container } = render(<LegalBasisCard {...card({ lane: 'baurecht_oib' })} />)
    expect(accentOf(container)).toContain('border-l-source-oib/40')
    expect(accentOf(container)).not.toContain('border-l-source-law/40')
  })

  it('keeps the law signal for a statute', () => {
    const { container } = render(<LegalBasisCard {...card({ law: 'Wiener Bauordnung', lane: 'baurecht_ris' })} />)
    expect(accentOf(container)).toContain('border-l-source-law/40')
    expect(accentOf(container)).not.toContain('border-l-source-oib/40')
  })

  it('does NOT derive the accent from the law name when no lane is on the wire', () => {
    // The regression the field exists to prevent: "OIB" in the string is not a
    // provenance claim, and a card that predates `lane` keeps the stratum
    // colour it already had rather than gaining one from a pattern match.
    const { container } = render(<LegalBasisCard {...card({ law: 'OIB-Richtlinie 2', lane: null })} />)
    expect(accentOf(container)).toContain('border-l-source-law/40')
    expect(accentOf(container)).not.toContain('border-l-source-oib/40')
  })
})

describe('LegalBasisCard authority badge', () => {
  it('names the tier in words, so the accent never travels as colour alone', () => {
    render(<LegalBasisCard {...card({ lane: 'baurecht_oib' })} />)
    expect(screen.getByTitle('Rechtsquelle: OIB')).toHaveTextContent('OIB')
  })

  it('names RIS for a statute', () => {
    render(<LegalBasisCard {...card({ law: 'Wiener Bauordnung', lane: 'baurecht_ris' })} />)
    expect(screen.getByTitle('Rechtsquelle: RIS')).toHaveTextContent('RIS')
  })

  it('claims no tier at all when the wire carries no lane', () => {
    render(<LegalBasisCard {...card({ lane: null })} />)
    expect(screen.queryByTitle(/Rechtsquelle:/)).toBeNull()
  })
})

describe('LegalBasisCard edition', () => {
  it('prints the Ausgabe, which is what makes the citation checkable', () => {
    render(<LegalBasisCard {...card({ lane: 'baurecht_oib', edition: 'Ausgabe Mai 2023' })} />)
    expect(screen.getByText('Ausgabe Mai 2023')).toBeInTheDocument()
  })

  it('renders without one rather than inventing one', () => {
    render(<LegalBasisCard {...card({ law: 'Wiener Bauordnung', lane: 'baurecht_ris', edition: null })} />)
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
    expect(screen.queryByText(/Ausgabe/)).toBeNull()
  })
})

describe('LegalBasisCard primary source', () => {
  it('sends an OIB citation to the OIB, and a statute to RIS', () => {
    const { unmount } = render(<LegalBasisCard {...card({ lane: 'baurecht_oib' })} />)
    expect(screen.getByRole('link', { name: /OIB-Richtlinie ansehen/ })).toHaveAttribute(
      'href',
      'https://www.oib.or.at/de/oib-richtlinien'
    )
    unmount()

    render(<LegalBasisCard {...card({ law: 'Wiener Bauordnung', lane: 'baurecht_ris', section: 'Abs. 4' })} />)
    expect(screen.getByRole('link', { name: /In RIS prüfen/ })).toHaveAttribute(
      'href',
      expect.stringContaining('ris.bka.gv.at')
    )
  })

  it('lets the lane overrule the law name', () => {
    // A document whose NAME says Richtlinie but whose LANE says RIS is verified
    // in RIS. The structured field is the claim; the string is a title.
    render(<LegalBasisCard {...card({ law: 'OIB-Richtlinie 2', lane: 'baurecht_ris' })} />)
    expect(screen.getByRole('link', { name: /In RIS prüfen/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /OIB-Richtlinie ansehen/ })).toBeNull()
  })
})

describe('LegalBasisCard text fields are plain text', () => {
  // A production card put „[OIB-Richtlinie ansehen](https://www.oib.or.at/de/
  // oib-richtlinien)“ on screen as literal brackets, beside this card's own
  // working link to that same page. The markup is stripped on the way in, by
  // `CardModel` in `src/aiq_agent/cards/models.py` — and it stays stripped
  // THERE. These pin the half of that decision that lives here: the renderer
  // must not acquire the ability to parse it. A card is what gets screenshotted
  // into an Einreichung, and a renderer that quietly read markdown in a field
  // nobody declared as markdown would be a way for the model to put an
  // arbitrary link, or emphasis, into a legal citation.

  it('sets a text field as text, never as markup', () => {
    const summary = 'Siehe **§ 3** und [RIS](https://ris.bka.gv.at)'
    const { container } = render(<LegalBasisCard {...card({ lane: 'baurecht_oib', summary })} />)

    expect(screen.getByText(summary)).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('<strong>')
    expect(container.innerHTML).not.toContain('<em>')
  })

  it('links only where the schema says a link goes', () => {
    // Every anchor on this card is one the card BUILT from `law`/`lane`, so the
    // set of links is decided by the schema and not by what a text field holds.
    render(
      <LegalBasisCard
        {...card({
          lane: 'baurecht_oib',
          summary: '[anderswo](https://example.invalid/smuggled)',
          original_text: '[auch hier](https://example.invalid/also)',
        })}
      />
    )

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://www.oib.or.at/de/oib-richtlinien')
  })
})

describe('the gallery pair', () => {
  it('ships a statute fixture whose lane and missing Ausgabe contrast with the OIB one', () => {
    // The map is keyed by card type and can hold one `legal_basis`; the pair is
    // what makes the lane's effect visible, so the companion must stay a real
    // statute rather than drifting into a second OIB citation.
    expect(previewFixtureFor('legal_basis')).toMatchObject({
      lane: 'baurecht_oib',
      edition: 'Ausgabe Mai 2023',
    })
    expect(LEGAL_BASIS_STATUTE).toMatchObject({ type: 'legal_basis', lane: 'baurecht_ris' })
    expect(LEGAL_BASIS_STATUTE).not.toHaveProperty('edition')
  })
})
