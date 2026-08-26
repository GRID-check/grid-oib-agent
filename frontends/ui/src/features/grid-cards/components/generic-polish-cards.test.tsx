/**
 * Render tests for the two GENERIC polish cards — key takeaways and the
 * callout. Focus: the block renders every takeaway; a takeaway's detail is
 * absent while collapsed and present after a click (the whole point of the
 * card is that the qualification survives without costing the block its
 * scannability); a takeaway with nothing behind it offers no expander; and the
 * callout names its kind in words, never by tint alone.
 */

import { describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import userEvent from '@testing-library/user-event'
import { KeyTakeawaysCard } from './KeyTakeawaysCard'
import { CalloutCard } from './CalloutCard'

/**
 * The cards render in German because the reader is Austrian, and the copy now
 * comes from the dictionary rather than from literals in the components. A
 * test that renders without a provider sees the default locale (`en`), so the
 * locale is pinned here; `fixedLocale` also skips the provider's preference
 * reconciliation, which would be a fetch.
 */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

describe('KeyTakeawaysCard', () => {
  const items = [
    {
      text: 'Fluchtniveau 9,80 m → Gebäudeklasse 4',
      detail: 'Maßgeblich ist das oberste Fluchtniveau; die Grenze zu GK 5 liegt bei 11 m.',
    },
    { text: 'Tragende Bauteile mindestens REI 60' },
  ]

  it('renders the title and every takeaway', () => {
    render(<KeyTakeawaysCard title="Gebäudeklasse 4 – das Wichtigste" items={items} />)

    // No eyebrow: §A2 retires the uppercase type label inside every card, so
    // the title is the only heading and „Das Wichtigste" is not printed at all.
    expect(screen.queryByText('Das Wichtigste')).not.toBeInTheDocument()
    expect(screen.getByText('Gebäudeklasse 4 – das Wichtigste')).toBeInTheDocument()
    expect(screen.getByText('Fluchtniveau 9,80 m → Gebäudeklasse 4')).toBeInTheDocument()
    expect(screen.getByText('Tragende Bauteile mindestens REI 60')).toBeInTheDocument()
  })

  it('expands a takeaway on click to reveal its detail (hidden while collapsed)', async () => {
    const user = userEvent.setup()
    render(<KeyTakeawaysCard title={null} items={items} />)

    expect(screen.queryByText(/Die Grenze zu GK 5|Grenze zu GK 5/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Fluchtniveau/ }))

    expect(screen.getByText(/Grenze zu GK 5 liegt bei 11 m/)).toBeInTheDocument()
  })

  it('gives a takeaway with no detail no expander to click', () => {
    render(<KeyTakeawaysCard title={null} items={items} />)

    // Exactly one row is a button — an expander that opens onto nothing would
    // teach the reader the chevrons are decorative.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('spends no figure at all — five roughly equal points are not a ranking', () => {
    // §A2: a card with no single answer spends no figure rather than picking
    // one arbitrarily. The previous revision typeset takeaway one larger,
    // which asserted an ordering the payload does not carry.
    render(<KeyTakeawaysCard title="Gebäudeklasse 4" items={items} />)

    for (const item of items) {
      expect(screen.getByText(item.text)).toHaveClass('card-title')
      expect(screen.getByText(item.text)).not.toHaveClass('card-figure-20')
      expect(screen.getByText(item.text)).not.toHaveClass('card-value')
    }
    expect(screen.getByText('Gebäudeklasse 4')).toHaveClass('card-title')
  })

  it('gives each takeaway its own recessed panel, with no rules between rows', () => {
    // The §A5 mark: separate recessed panels, not rows in a divided list.
    // Hairlines between rows are what made this a generic list — four cards in
    // the set drew the same rules around the same rows.
    const four = [
      { text: 'Erstens' },
      { text: 'Zweitens' },
      { text: 'Drittens' },
      { text: 'Viertens' },
    ]
    const { container } = render(<KeyTakeawaysCard title={null} items={four} />)

    expect(container.querySelectorAll('.bg-input-background')).toHaveLength(4)
    expect(
      container.querySelector('[class*="divide-y"]'),
      'a hairline per row is the generic-list look the panels replace',
    ).toBeNull()
  })

  it('lightens a takeaway from the recessed ground to the card surface when it opens', async () => {
    // The disclosure state is carried by the SURFACE, so an open row is
    // legible before it is read. Nothing else in the set changes ground on
    // disclosure, which is what makes the mark this card's alone.
    const user = userEvent.setup()
    const { container } = render(<KeyTakeawaysCard title={null} items={items} />)

    expect(container.querySelectorAll('.bg-input-background')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: /Fluchtniveau/ }))

    expect(container.querySelectorAll('.bg-input-background')).toHaveLength(1)
    // Scoped to the list: the card itself is `bg-card` too, and the assertion
    // is about the PANEL having changed ground, not about the card having one.
    expect(container.querySelectorAll('ol .bg-card')).toHaveLength(1)
  })

  it('skips a takeaway with no text and keeps the ordinals contiguous', () => {
    // Every field inside every array item reaches the renderer unvalidated
    // (§0.5.1), so a missing `text` is a normal input, not a crash. „01, 03"
    // would tell the reader something was withheld.
    render(
      <KeyTakeawaysCard
        title={null}
        items={[{ text: 'Erstens' }, { text: '' }, { text: 'Drittens' }] as typeof items}
      />,
    )

    expect(screen.getByText('Erstens')).toBeInTheDocument()
    expect(screen.getByText('Drittens')).toBeInTheDocument()
    expect(screen.getByText('01')).toBeInTheDocument()
    expect(screen.getByText('02')).toBeInTheDocument()
    expect(screen.queryByText('03')).not.toBeInTheDocument()
  })
})

describe('CalloutCard', () => {
  it('names its kind in words beside the remark', () => {
    render(
      <CalloutCard
        kind="frist"
        title="Nur in Wien"
        text="Die Bauverhandlung ist binnen sechs Wochen anzuberaumen."
        detail={null}
      />,
    )

    expect(screen.getByText('Frist')).toBeInTheDocument()
    expect(screen.getByText('Nur in Wien')).toBeInTheDocument()
    expect(screen.getByText(/binnen sechs Wochen/)).toBeInTheDocument()
  })

  it('renders no disclosure at all when there is no background to show', () => {
    render(<CalloutCard kind="tipp" text="Ein Schnitt durch das Treppenhaus erspart Rückfragen." />)

    expect(screen.getByText('Tipp')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('expands the background on click (absent while collapsed)', async () => {
    const user = userEvent.setup()
    render(
      <CalloutCard
        kind="achtung"
        text="Die Wiener Bauordnung weicht bei der Berechnung des Fluchtniveaus ab."
        detail="Für Zubauten im Bestand ist zusätzlich § 60 zu beachten."
      />,
    )

    expect(screen.queryByText(/§ 60/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Mehr dazu/ }))

    expect(screen.getByText(/§ 60/)).toBeInTheDocument()
  })

  it('is a bare recessed panel, capped narrower than the column it sits in', () => {
    // The §A5 mark, both halves: no card around it (FLAT register — a remark
    // on the same white plate as the evidence beside it reads AS evidence),
    // and a cap so it stops short of the column. `ch` rather than px so the
    // cap is a measure and follows the type.
    const { container } = render(
      <CalloutCard kind="hinweis" text="Die Frist läuft ab Zustellung des Bescheids." />,
    )

    expect(
      container.querySelector('[data-slot="card"]'),
      'a frame around a margin note is what makes it read as evidence',
    ).toBeNull()

    const panel = container.firstElementChild
    expect(panel, 'the callout IS its panel — recessed ground and a hairline').toHaveClass(
      'bg-input-background',
    )
    expect(
      panel,
      'without the cap the callout is the same width as every other card and stops reading as an aside',
    ).toHaveClass('max-w-[46ch]')
  })
})
