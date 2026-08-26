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

    expect(screen.getByText('Das Wichtigste')).toBeInTheDocument()
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

  it('spends the card’s one figure on the first takeaway and nothing else', () => {
    // §A2: a card carries exactly one element above 14px and it must be the
    // card's answer. This card's answer is five things, so the figure goes to
    // the first — a reader who reads nothing else reads takeaway one.
    render(<KeyTakeawaysCard title="Gebäudeklasse 4" items={items} />)

    expect(screen.getByText(items[0].text)).toHaveClass('card-value')
    expect(screen.getByText(items[1].text)).toHaveClass('card-body')
    expect(screen.getByText(items[1].text)).not.toHaveClass('card-value')
    // The title is the Title step, NOT a second thing above 14px.
    expect(screen.getByText('Gebäudeklasse 4')).toHaveClass('card-title')
  })

  it('steps each takeaway further right than the one above it, with no rules between rows', () => {
    // The §A5 mark: "ordinals in a descending staircase". Hairlines between
    // rows are what made this a generic list — four cards in the set drew the
    // same rules around the same rows — so the rank is drawn, not ruled.
    const four = [
      { text: 'Erstens' },
      { text: 'Zweitens' },
      { text: 'Drittens' },
      { text: 'Viertens' },
    ]
    const { container } = render(<KeyTakeawaysCard title={null} items={four} />)

    const staircase = ['pl-0', 'pl-1.5', 'pl-3', 'pl-4.5']
    four.forEach((item, index) => {
      expect(
        screen.getByText(item.text),
        `takeaway ${index + 1} should sit ${index * 6}px in from the one above it`,
      ).toHaveClass(staircase[index])
    })
    expect(
      container.querySelector('[class*="divide-y"]'),
      'a hairline per row is the generic-list look the staircase replaces',
    ).toBeNull()
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

  it('is capped narrower than the column it sits in', () => {
    // The §A5 mark: "the only card narrower than the column". A remark that
    // spans the full 636px reads as a section of the answer; one that stops
    // short of it reads as an aside, which is what a callout is. `ch` rather
    // than px so the cap is a measure and follows the type.
    const { container } = render(
      <CalloutCard kind="hinweis" text="Die Frist läuft ab Zustellung des Bescheids." />,
    )

    expect(
      container.querySelector('[data-slot="card"]'),
      'without the cap the callout is the same width as every other card and stops reading as an aside',
    ).toHaveClass('max-w-[46ch]')
  })
})
