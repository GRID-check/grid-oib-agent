/**
 * Specs render in the English dictionary; the answer's own words stay German.
 *
 * The answer's directive dialect, drawn: each block from plain Markdown, and
 * nothing lost when a name is unknown or a text merely looks like a directive.
 */
import { fireEvent, render, screen, within } from '@/test-utils'
import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './MarkdownRenderer'
import { ExcerptSourceProvider, MarkdownRowActionProvider } from './answer-block-context'

const CHECK = [
  ':::check',
  '| Anforderung | Ist | Soll | Stand |',
  '|---|---|---|---|',
  '| Trittschall | 57 dB | ≥ 55 dB | erfüllt |',
  '| Fluchtweglänge | 38 m | ≤ 40 m | offen |',
  '| Brandabschnitt | 1.380 m² | max. 1.200 m² | erfüllt |',
  '| Rauchabzug | — | — | zu prüfen |',
  ':::',
].join('\n')

const PASSING = [
  ':::check',
  '| Anforderung | Ist | Soll | Stand |',
  '|---|---|---|---|',
  '| Trittschall | 57 dB | ≥ 55 dB | erfüllt |',
  '| Geländer | 1,10 m | ≥ 1,00 m | erfüllt |',
  '| U-Wert Dach | 0,15 W/m²K | ≤ 0,20 W/m²K | erfüllt |',
  '| Fluchtweg | 38 m | ≤ 40 m | erfüllt |',
  ':::',
].join('\n')


/**
 * Whether the disclosure holding `element` is open. A closed disclosure stays
 * in the page (it prints open, `PRINT_OPEN_CONTENT`) and is hidden by its
 * `data-state`, which jsdom does not apply as CSS.
 */
const panelState = (element: HTMLElement): string | null =>
  element.closest('[data-slot="collapsible-content"]')?.getAttribute('data-state') ?? null

describe('text that only looks like a directive', () => {
  it('keeps „10:30" and „Hinweis:Achtung" exactly as written', () => {
    const { container } = render(<MarkdownRenderer content={'Termin 10:30 Uhr, Hinweis:Achtung und :unbekannt[x].'} />)
    expect(container.textContent).toContain('Termin 10:30 Uhr, Hinweis:Achtung und :unbekannt[x].')
  })

  it('draws an unknown block as its content, without fences', () => {
    const { container } = render(<MarkdownRenderer content={':::sonstwas\nInhalt bleibt.\n:::'} />)
    expect(container.textContent).toContain('Inhalt bleibt.')
    expect(container.textContent).not.toContain(':::')
  })
})

describe(':::check', () => {
  it('finds the status column by its content and marks every row', () => {
    render(<MarkdownRenderer content={CHECK} />)
    expect(screen.getAllByTestId('status-mark')).toHaveLength(4)
  })

  it('draws the value against the limit, with the numbers in its name', () => {
    render(<MarkdownRenderer content={CHECK} />)
    const bars = screen.getAllByTestId('value-bar')
    expect(bars).toHaveLength(3)
    expect(bars[0]).toHaveAccessibleName('57 dB, limit ≥ 55 dB, met')
    expect(bars[2]).toHaveAttribute('data-pass', 'false')
  })

  it('lets the computed outcome win: an open word becomes the result, a contradiction is flagged', () => {
    const { container } = render(<MarkdownRenderer content={CHECK} />)
    const rows = container.querySelectorAll('tbody tr')
    // 38 m ≤ 40 m: „offen" is replaced by the computed outcome (English copy here).
    expect(within(rows[1] as HTMLElement).getByTestId('status-mark')).toHaveTextContent('met')
    // 1.380 m² against max. 1.200 m² written as „erfüllt": a Widerspruch.
    expect(rows[2]).toHaveAttribute('data-conflict', 'true')
    expect(within(rows[2] as HTMLElement).getByTestId('status-mark')).toHaveTextContent('Contradiction – check')
    expect(screen.getByTestId('status-tally').textContent).toContain('1 unresolved')
  })

  it('collapses a check that passes everywhere to one line', () => {
    render(<MarkdownRenderer content={PASSING} />)
    expect(screen.getByTestId('check-passed')).toHaveTextContent('4 of 4 met')
    // Kept in the page so it prints, but closed on screen.
    expect(panelState(screen.getByRole('table'))).toBe('closed')
    fireEvent.click(screen.getByTestId('check-passed'))
    expect(panelState(screen.getByRole('table'))).toBe('open')
  })

  it('offers „Dazu fragen" on an open row only where the surface supplies it', () => {
    const asked: string[] = []
    render(
      <MarkdownRowActionProvider
        render={({ subject }) => {
          asked.push(subject)
          return <button type="button">Dazu fragen</button>
        }}
      >
        <MarkdownRenderer content={CHECK} />
      </MarkdownRowActionProvider>
    )
    expect(screen.getAllByRole('button', { name: 'Dazu fragen' }).length).toBeGreaterThan(0)
    expect(asked).toContain('Rauchabzug')
    expect(asked).toContain('Brandabschnitt')
  })

  it('draws no row action without a surface that supplies one', () => {
    render(<MarkdownRenderer content={CHECK} />)
    expect(screen.queryByRole('button', { name: 'Dazu fragen' })).toBeNull()
  })
})

describe(':::procedure', () => {
  const STEPS = [
    ':::procedure',
    '1. Vorprüfung durch die Baubehörde',
    '2. Einreichung der Unterlagen **binnen 6 Wochen** :current',
    '   :::details[Was es braucht]',
    '   Einreichpläne, Baubeschreibung, Energieausweis',
    '   :::',
    '3. Bauverhandlung',
    ':::',
  ].join('\n')

  it('keeps every step in one rail, even with a nested details block', () => {
    const { container } = render(<MarkdownRenderer content={STEPS} />)
    expect(container.querySelectorAll('li[data-phase]')).toHaveLength(3)
    expect(container.textContent).not.toContain(':::')
  })

  it('marks the step the project is at, and the ones before it as done', () => {
    const { container } = render(<MarkdownRenderer content={STEPS} />)
    const phases = [...container.querySelectorAll('li[data-phase]')].map((li) => li.getAttribute('data-phase'))
    expect(phases).toEqual(['done', 'current', 'upcoming'])
    expect(screen.getByText('you are here')).toBeInTheDocument()
    expect(screen.getByText('binnen 6 Wochen')).toBeInTheDocument()
  })

  it('opens a step to what it needs', () => {
    render(<MarkdownRenderer content={STEPS} />)
    expect(panelState(screen.getByText(/Einreichpläne/))).toBe('closed')
    fireEvent.click(screen.getByRole('button', { name: /Step 2/ }))
    expect(panelState(screen.getByText(/Einreichpläne/))).toBe('open')
    expect(screen.getByText('Was es braucht')).toBeInTheDocument()
  })
})

describe(':::cases', () => {
  it('tints the case that applies and mutes the others, in a table', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          ':::cases',
          '| Fall | Folge | Stand |',
          '|---|---|---|',
          '| Fluchtniveau ≤ 7 m | GK 2 | trifft nicht zu |',
          '| Fluchtniveau ≤ 11 m | GK 4 | trifft zu |',
          ':::',
        ].join('\n')}
      />
    )
    const rows = container.querySelectorAll('tbody tr')
    expect(rows[1]).toHaveAttribute('data-active', 'true')
    expect(rows[0]).not.toHaveAttribute('data-active')
  })

  it('reads a :applies marker on a list item', () => {
    const { container } = render(
      <MarkdownRenderer content={':::cases\n- Bis 7 m: GK 2\n- Bis 11 m: GK 4 :applies\n:::'} />
    )
    const items = container.querySelectorAll('li')
    expect(items[1]).toHaveAttribute('data-active', 'true')
    expect(container.textContent).not.toContain(':applies')
  })
})

describe(':::details', () => {
  it('opens on click and starts closed', () => {
    render(<MarkdownRenderer content={':::details[Herleitung]\nDer Wert folgt aus Tabelle 2.\n:::'} />)
    expect(panelState(screen.getByText('Der Wert folgt aus Tabelle 2.'))).toBe('closed')
    fireEvent.click(screen.getByRole('button', { name: /Herleitung/ }))
    expect(panelState(screen.getByText('Der Wert folgt aus Tabelle 2.'))).toBe('open')
  })
})

describe(':energy-class', () => {
  it('draws an Energieeffizienzklasse on its band, and leaves anything else as text', () => {
    const { container } = render(<MarkdownRenderer content={'Klasse :energy-class[B], nicht :energy-class[Z].'} />)
    expect(screen.getByTestId('energy-class')).toHaveAttribute('data-class', 'B')
    expect(container.textContent).toContain(':energy-class[Z]')
  })
})

describe(':::metrics', () => {
  it('draws each item as a figure, toned by its limit', () => {
    render(
      <MarkdownRenderer
        content={':::metrics\n- Bruttogeschoßfläche: 1.180 m² (max. 1.200 m²)\n- Stellplätze: 12 (mind. 14)\n- Geschoße: 4\n:::'}
      />
    )
    const tiles = screen.getAllByTestId('figure-tile')
    expect(tiles.map((tile) => tile.getAttribute('data-tone'))).toEqual(['success', 'destructive', 'none'])
    expect(tiles[0]).toHaveTextContent('1.180 m²')
    expect(tiles[0]).toHaveTextContent('Bruttogeschoßfläche')
  })
})

describe(':::compare', () => {
  const COMPARE = [
    ':::compare',
    '| Kriterium | Außentreppe | Zweites Treppenhaus :recommended |',
    '|---|---|---|',
    '| Kosten | gering | hoch |',
    '| Fluchtweg | erfüllt | erfüllt |',
    ':::',
  ].join('\n')

  it('highlights the recommended variant and marks status words in every cell', () => {
    const { container } = render(<MarkdownRenderer content={COMPARE} />)
    expect(container.querySelector('th[data-recommended]')).toHaveTextContent('Zweites Treppenhaus')
    expect(container.textContent).not.toContain(':recommended')
    expect(container.querySelectorAll('table [data-testid="status-mark"]')).toHaveLength(2)
  })

  it('builds one block per variant for a phone', () => {
    render(<MarkdownRenderer content={COMPARE} />)
    const stack = screen.getByTestId('compare-stack')
    expect(stack.querySelectorAll('section')).toHaveLength(2)
    expect(stack.querySelector('section[data-recommended]')).toHaveTextContent('Zweites Treppenhaus')
  })
})

describe('a Fundstelle excerpt', () => {
  const QUOTE = '> „Fluchtwege müssen ins Freie führen." [1]'

  it('sets the source in the margin when the surface resolves it', () => {
    const { container } = render(
      <ExcerptSourceProvider render={({ number }) => <span>Quelle {number}: OIB-RL 4</span>}>
        <MarkdownRenderer content={QUOTE} />
      </ExcerptSourceProvider>
    )
    expect(container.querySelector('figure[data-excerpt="1"]')).not.toBeNull()
    expect(screen.getByText('Quelle 1: OIB-RL 4')).toBeInTheDocument()
  })

  it('stays a plain quote when it does not end in a citation', () => {
    const { container } = render(<MarkdownRenderer content={'> Ein Zitat ohne Quelle.'} />)
    expect(container.querySelector('figure')).toBeNull()
    expect(container.querySelector('blockquote')).toHaveTextContent('Ein Zitat ohne Quelle.')
  })
})

describe('any table', () => {
  it('tints the row whose Status says it holds', () => {
    const { container } = render(
      <MarkdownRenderer content={'| Fall | Status |\n|---|---|\n| A | trifft nicht zu |\n| B | trifft zu |'} />
    )
    expect(container.querySelectorAll('tbody tr')[1]).toHaveAttribute('data-active', 'true')
  })

  it('sets a column of values right-aligned, and leaves a column of classes alone', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'| Bauteil | Klasse | Fläche |\n|---|---|---|\n| Decke | EI 60 | 1.200 m² |\n| Wand | EI 90 | 3,5 m² |'}
      />
    )
    const cells = container.querySelectorAll('tbody tr:first-child td')
    expect(cells[2]).toHaveAttribute('data-numeric', 'true')
    expect(cells[2].className).toContain('text-right')
    expect(cells[1]).not.toHaveAttribute('data-numeric')
  })
})
