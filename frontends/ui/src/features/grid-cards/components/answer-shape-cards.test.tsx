/**
 * Render tests for the four "answer shape" cards — the verdict header, the
 * condition tree, the typed table and the norm chain. Focus: each renders its
 * headline content, the active branch is marked, typed columns render by type
 * (a verdict cell as its German word, a numeric column right-aligned), and the
 * norm chain distinguishes binding from interpretive links in words, not colour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { VerdictHeaderCard } from './VerdictHeaderCard'
import { ConditionTreeCard } from './ConditionTreeCard'
import { TypedTableCard } from './TypedTableCard'
import { NormChainCard } from './NormChainCard'

describe('VerdictHeaderCard', () => {
  it('renders the subject, the verdict and the confidence label', () => {
    render(
      <VerdictHeaderCard
        verdict="1,10 m"
        subject="Erforderliche Geländerhöhe"
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 4.3' }}
        confidence="high"
        confidence_reason={null}
      />,
    )

    expect(screen.getByText('Erforderliche Geländerhöhe')).toBeInTheDocument()
    expect(screen.getByText('1,10 m')).toBeInTheDocument()
    expect(screen.getByText('hohe Sicherheit')).toBeInTheDocument()
    // The grounding norm rides in the shared citation footer.
    expect(screen.getByText('OIB-Richtlinie 4')).toBeInTheDocument()
  })

  it('sets the verdict at the largest step in the system, and steps it down for a long one', () => {
    // §B1: the card IS the figure. 30px is the biggest type anywhere in the
    // card set, and the branch is on the STRING rather than the viewport —
    // „Hauptgeschoßfußbodenoberkante über 22 m" is too long for one line in the
    // 636px desktop column and the 314px phone one alike.
    const { unmount } = render(
      <VerdictHeaderCard verdict="1,10 m" subject="Geländerhöhe" confidence={null} />,
    )
    expect(screen.getByText('1,10 m')).toHaveClass('card-figure-30')
    unmount()

    const long = 'Hauptgeschoßfußbodenoberkante über 22 m'
    render(<VerdictHeaderCard verdict={long} subject="Hochhaus" confidence={null} />)
    expect(screen.getByText(long), `${long.length} characters cannot hold 30px`).toHaveClass(
      'card-figure-24',
    )
  })

  it('renders confidence as three segments filled to level, and still writes the word', () => {
    // A pill is legible but not COMPARABLE: two answers side by side give the
    // reader two words and no sense of which one the product is surer of.
    // Three segments is exact rather than a rounding — the enum has exactly
    // three values, so the gauge encodes the field and interpolates nothing.
    render(<VerdictHeaderCard verdict="REI 90" subject="Feuerwiderstand" confidence="medium" />)

    // Found through the WORD rather than through the cells' own classes: the
    // word is the part of this that carries meaning, and the gauge's shape is
    // exactly the part expected to be retuned.
    const row = screen.getByText('mittlere Sicherheit').parentElement
    const cells = row?.querySelectorAll('span[aria-hidden="true"] > span') ?? []
    expect(cells).toHaveLength(3)
    expect(Array.from(cells).map((cell) => cell.classList.contains('bg-foreground'))).toEqual([
      true,
      true,
      false,
    ])
  })

  it('leaves the gauge out entirely when the answer carries no confidence', () => {
    const { container } = render(
      <VerdictHeaderCard verdict="Nicht geregelt" subject="Wartungsleiter" confidence={null} />,
    )

    expect(
      container.querySelectorAll('span[aria-hidden="true"] > span'),
      'an empty gauge would read as "lowest confidence", which is a claim the card was not given',
    ).toHaveLength(0)
  })
})

/**
 * The cards render in German because the reader is Austrian; `fixedLocale`
 * pins it so the copy is the same on every machine, and skips the provider's
 * preference reconciliation (which would be a fetch, and this file asserts
 * there is none).
 */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>,
  )

describe('ConditionTreeCard', () => {
  const branches = [
    { condition: 'GK 1–3', outcome: 'REI 30' },
    { condition: 'GK 4', outcome: 'REI 60', active: true },
    {
      condition: 'GK 5',
      outcome: 'REI 90',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
    },
  ]

  const tree = (
    <ConditionTreeCard
      title="Erforderliche Feuerwiderstandsklasse"
      question="Gebäudeklasse"
      branches={branches}
      reference={{ document: 'OIB-Richtlinie 2', edition: 'Ausgabe Mai 2023' }}
    />
  )

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the deciding factor, every case, and marks the one that applies', () => {
    render(tree)

    expect(screen.getByText('Gebäudeklasse')).toBeInTheDocument()
    // Every case is present, open or not.
    expect(screen.getByText('GK 1–3')).toBeInTheDocument()
    expect(screen.getByText('GK 4')).toBeInTheDocument()
    expect(screen.getByText('GK 5')).toBeInTheDocument()
    // The matching case is called out in words, not by colour alone — and in
    // the semantics, so the marking survives a screen reader too.
    expect(screen.getByText('trifft zu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp('^GK 4') })).toHaveAttribute('aria-current', 'true')
    // It starts open, in the indicative: this is the reader's answer.
    expect(screen.getByText('Für dieses Projekt gilt:')).toBeInTheDocument()
    expect(screen.getAllByText('REI 60').length).toBeGreaterThan(0)
  })

  it('opens another case from data already on screen — no turn, no fetch', async () => {
    const user = userEvent.setup()
    render(tree)

    // GK 5 starts closed, so the norm it rests on is not in the document yet.
    // The section (unique to the branch) stands in for the whole reference
    // block; the bare document name also rides in the card footer.
    expect(screen.queryByText('Tabelle 1b')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: new RegExp('^GK 5') }))

    // „Ich klick das und sehe mehr" — the case is answered from what was
    // already in the browser: its outcome large, its Grundlage revealed.
    expect(screen.getAllByText('REI 90').length).toBe(2)
    expect(screen.getByText('Tabelle 1b')).toBeInTheDocument()
    expect(screen.getByText('Grundlage')).toBeInTheDocument()
    // Nothing left the client. This is the whole promise of the interaction.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the case that applies marked while another one is being read', async () => {
    const user = userEvent.setup()
    render(tree)

    await user.click(screen.getByRole('button', { name: new RegExp('^GK 5') }))

    // One at a time: the indicative lead-in belongs to the active case only,
    // and it went away with it.
    expect(screen.queryByText('Für dieses Projekt gilt:')).not.toBeInTheDocument()
    // The Konjunktiv says in the grammar itself that this is a what-if.
    expect(screen.getByText('Bei GK 5 würde gelten:')).toBeInTheDocument()
    // The correction rides inside the opened panel, naming the case that DOES
    // apply and its outcome — this is what a cropped screenshot still carries.
    expect(
      screen.getByText('Nur zum Vergleich — für dieses Projekt gilt GK 4: REI 60'),
    ).toBeInTheDocument()
    // And the marking on the active row never moved.
    expect(screen.getByText('trifft zu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp('^GK 4') })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: new RegExp('^GK 5') })).not.toHaveAttribute('aria-current')
  })

  it('goes back to the case that applies from inside the previewed one', async () => {
    const user = userEvent.setup()
    render(tree)

    await user.click(screen.getByRole('button', { name: new RegExp('^GK 5') }))
    await user.click(screen.getByRole('button', { name: 'Zurück zu GK 4' }))

    expect(screen.getByText('Für dieses Projekt gilt:')).toBeInTheDocument()
    expect(screen.queryByText('Bei GK 5 würde gelten:')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opens a case from the keyboard alone', async () => {
    const user = userEvent.setup()
    render(tree)

    await user.tab()
    expect(screen.getByRole('button', { name: new RegExp('^GK 1–3') })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(screen.getByText('Bei GK 1–3 würde gelten:')).toBeInTheDocument()
  })

  it('contrasts nothing, and opens nothing, when no case is marked as applying', () => {
    render(
      <ConditionTreeCard
        title="Erforderliche Feuerwiderstandsklasse"
        question="Gebäudeklasse"
        branches={[{ condition: 'GK 1–3', outcome: 'REI 30' }]}
        reference={null}
      />,
    )

    expect(screen.queryByText('trifft zu')).not.toBeInTheDocument()
    // Nothing opens on the reader's behalf, and nothing is contrasted.
    expect(screen.queryByText('Bei GK 1–3 gilt:')).not.toBeInTheDocument()
  })

  it('marks one case even when a stored card claims several', () => {
    // Field evidence: a „Feuerwiderstand in GK 4" tree arrived with all three
    // branches active, so the reader saw three simultaneous outcomes each
    // captioned „für dieses Projekt gilt". Pydantic now rejects that shape, but
    // a card is data that outlives the code that wrote it — a stored answer
    // from before the validator still has to render as ONE decision or none.
    render(
      <ConditionTreeCard
        title="Erforderliche Feuerwiderstandsklasse"
        question="Lage des Bauteils"
        branches={[
          { condition: 'oberstes oberirdisches Geschoß', outcome: 'R 60', active: true },
          { condition: 'sonstiges oberirdisches Geschoß', outcome: 'R 60', active: true },
          { condition: 'unterirdisches Geschoß', outcome: 'R 90 und A2', active: true },
        ]}
        reference={null}
      />,
    )

    expect(screen.getAllByText('trifft zu')).toHaveLength(1)
  })
})

describe('TypedTableCard', () => {
  it('renders columns by type: a verdict word and a numeric cell', () => {
    render(
      <TypedTableCard
        title="Mindestmaße barrierefreie Erschließung"
        columns={[
          { label: 'Bauteil', type: 'text' },
          { label: 'Mindestmaß', type: 'mass' },
          { label: 'Erfüllt', type: 'verdict' },
        ]}
        rows={[
          ['Türdurchgangsbreite', '90 cm', 'erfüllt'],
          ['Rampenneigung', '6 %', 'nicht erfüllt'],
        ]}
        reference={{ document: 'ÖNORM B 1600' }}
        note={null}
      />,
    )

    expect(screen.getByRole('columnheader', { name: 'Mindestmaß' })).toBeInTheDocument()
    expect(screen.getByText('Türdurchgangsbreite')).toBeInTheDocument()
    expect(screen.getByText('90 cm')).toBeInTheDocument()
    // A verdict cell renders its German word as a status chip, with the word
    // carrying the verdict (colour never travels alone).
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
  })
})

describe('NormChainCard', () => {
  it('renders the chain and tags binding vs interpretive links', () => {
    render(
      <NormChainCard
        title="Normenkette – Absturzsicherung"
        links={[
          { label: 'Wiener Bautechnikverordnung', rank: 'verordnung', note: 'erklärt die OIB-Richtlinien' },
          { label: 'OIB-Richtlinie 4', rank: 'oib_richtlinie', note: null },
          { label: 'ÖNORM B 1600', rank: 'oenorm', note: null },
        ]}
      />,
    )

    expect(screen.getByText('Wiener Bautechnikverordnung')).toBeInTheDocument()
    expect(screen.getByText('ÖNORM B 1600')).toBeInTheDocument()
    // A binding link is tagged "bindend"; the OIB-Richtlinie carries its caveat;
    // an interpretive ÖNORM is tagged "auslegend".
    expect(screen.getByText('bindend')).toBeInTheDocument()
    expect(screen.getByText('bindend, wenn erklärt')).toBeInTheDocument()
    expect(screen.getByText('auslegend')).toBeInTheDocument()
  })
})
