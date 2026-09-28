/**
 * Specs render in the English dictionary; the answer's own words stay German.
 *
 * The blocks that draw the record rather than the model's words: the project's
 * values (`:project[key]`, `:::cases{by=…}` and its ruler), the composer
 * prefills of „ergänzen" and „Als Aufgabe", „Gesucht in" from the retrieval
 * ledger, the subsumption's three parts, and the server's quote stamps.
 */
import { fireEvent, render, screen, within } from '@/test-utils'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectProfile } from '@/lib/project-profile/types'
import { projectFactResolver } from '@/lib/project-profile/answer-bindings'
import { MarkdownRenderer } from './MarkdownRenderer'
import { AnswerDataProvider, type AnswerData } from './answer-block-context'

const at = '2026-09-20T08:00:00Z'

const PROFILE: ProjectProfile = {
  facts: {
    bundesland: { value: 'wien', confidence: 'confirmed', source: 'onboarding', updatedAt: at },
    gebaeudeklasse: { value: 'GK4', confidence: 'confirmed', source: 'onboarding', updatedAt: at },
    fluchtniveau_m: { value: 10.8, confidence: 'confirmed', source: 'onboarding', updatedAt: at },
  },
  goals: {},
  unknowns: [],
  assumptions: {
    geschosse_oberirdisch: { value: 5, status: 'unconfirmed', reason: 'geschätzt', source: 'agent_suggested', updatedAt: at },
  },
}

const withData = (data: AnswerData, content: string) =>
  render(
    <AnswerDataProvider value={data}>
      <MarkdownRenderer content={content} />
    </AnswerDataProvider>
  )

const project = projectFactResolver(PROFILE)

describe(':project[key]', () => {
  it('prints the profile value, never the key, in the chip of its state', () => {
    withData({ project }, 'In :project[building_class], :project[storeys] Geschoße, BGF :project[gross_floor_area_m2].')
    const chips = screen.getAllByTestId('project-value')
    expect(chips.map((chip) => chip.getAttribute('data-state'))).toEqual(['confirmed', 'assumed', 'missing'])
    expect(chips[0]).toHaveTextContent('GK 4')
    expect(chips[1]).toHaveTextContent('5')
    expect(chips[1]).toHaveTextContent('Assumption')
    expect(chips[2]).toHaveTextContent('Gross floor area')
    expect(chips[2]).toHaveTextContent('missing · add')
    expect(screen.queryByText(/building_class/)).toBeNull()
  })

  it('fills the composer when a missing fact is asked for, and writes nothing', () => {
    const prefill = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    withData({ project, prefill }, 'BGF :project[gross_floor_area_m2].')
    fireEvent.click(screen.getByRole('button', { name: /Gross floor area/ }))
    expect(prefill).toHaveBeenCalledWith(expect.stringContaining('Gross floor area'))
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('prints an unknown key as its text, never as a directive', () => {
    withData({ project }, 'Fläche :project[parcel_area_m2].')
    expect(screen.getByText('Fläche parcel_area_m2.')).toBeInTheDocument()
    expect(screen.queryByTestId('project-value')).toBeNull()
  })

  it('prints the fact name without a project to bind', () => {
    render(<MarkdownRenderer content={'Klasse :project[building_class].'} />)
    expect(screen.getByTestId('project-value')).toHaveAttribute('data-state', 'unbound')
    expect(screen.getByTestId('project-value')).toHaveTextContent('Building class')
  })
})

const CASES_BY_CLASS = [
  ':::cases{by=building_class}',
  '| Gebäudeklasse | Anforderung | Stand |',
  '|---|---|---|',
  '| GK 3 | R 30 | trifft zu |',
  '| GK 4 | R 60 | trifft nicht zu |',
  '| GK 5 | R 90 | trifft nicht zu |',
  ':::',
].join('\n')

describe(':::cases{by=…}', () => {
  it("marks the project's case itself and overrules the model's mark that disagrees", () => {
    withData({ project }, CASES_BY_CLASS)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[1]).toHaveAttribute('data-active', 'true')
    expect(rows[0]).not.toHaveAttribute('data-active')
    expect(within(rows[1]).getByTestId('status-mark')).toHaveAttribute('data-case', 'holds')
    expect(within(rows[1]).getByTestId('status-mark')).toHaveTextContent('applies')
    // The model wrote „trifft zu" on GK 3: overruled, never drawn beside the renderer's mark.
    const overruled = within(rows[0]).getByTestId('status-mark')
    expect(overruled).toHaveAttribute('data-case', 'overruled')
    expect(overruled).toHaveTextContent('does not apply')
    expect(screen.getByTestId('case-project')).toHaveTextContent('GK 4')
  })

  it("keeps the model's marks where there is no project to decide from", () => {
    render(<MarkdownRenderer content={CASES_BY_CLASS} />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveAttribute('data-active', 'true')
    expect(screen.queryByTestId('case-project')).toBeNull()
  })

  it('marks no case and asks for the value when the profile lacks it', () => {
    withData({ project: projectFactResolver({}) }, CASES_BY_CLASS)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.every((row) => !row.hasAttribute('data-active'))).toBe(true)
    expect(within(screen.getByTestId('case-project')).getByTestId('project-value')).toHaveAttribute('data-state', 'missing')
  })

  it('draws a threshold ruler with the pin at the project value', () => {
    withData(
      { project },
      [
        ':::cases{by=escape_level_m}',
        '- Fluchtniveau bis 7 m: GK 3',
        '- Fluchtniveau über 7 m bis 11 m: GK 4',
        '- Fluchtniveau über 11 m bis 22 m: GK 5',
        ':::',
      ].join('\n')
    )
    const ruler = screen.getByTestId('threshold-ruler')
    expect(within(ruler).getByTestId('ruler-pin')).toHaveTextContent('10,8 m')
    expect(ruler).toHaveTextContent('0,2 m below GK 5')
    const items = screen.getAllByRole('listitem')
    expect(items[1]).toHaveAttribute('data-active', 'true')
  })

  it('stays a table, marked as written, when the cases do not parse', () => {
    withData(
      { project },
      [':::cases{by=escape_level_m}', '| Lage | Stand |', '|---|---|', '| innen | trifft zu |', '| außen | offen |', ':::'].join('\n')
    )
    expect(screen.queryByTestId('threshold-ruler')).toBeNull()
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-active', 'true')
  })
})

const ACTIONS = [
  ':::actions',
  '| Wer | Was | bis | Fundstelle |',
  '|---|---|---|---|',
  '| Planer | Brandschutzkonzept nachreichen | vor Einreichung | [2] |',
  ':::',
].join('\n')

describe(':::actions', () => {
  it('offers „Als Aufgabe", which only fills the composer', () => {
    const prefill = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    withData({ prefill }, ACTIONS)
    fireEvent.click(screen.getByRole('button', { name: /Brandschutzkonzept nachreichen/ }))
    expect(prefill).toHaveBeenCalledTimes(1)
    const [text] = prefill.mock.calls[0] as [string]
    expect(text).toContain('Brandschutzkonzept nachreichen')
    expect(text).toContain('Planer')
    expect(text).toContain('vor Einreichung')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('draws no button without a composer, and the role as a chip', () => {
    render(<MarkdownRenderer content={ACTIONS} />)
    expect(screen.queryByTestId('prefill-button')).toBeNull()
    expect(screen.getByText('Planer')).toBeInTheDocument()
  })
})

const NOT_FOUND = [
  ':::not-found',
  '> „Außenwandbekleidungen sind aus A2 auszuführen." [1]',
  '',
  'Entscheidet: die Baubehörde im Einzelfall.',
  ':::',
].join('\n')

describe(':::not-found', () => {
  it('fills „Gesucht in" from the ledger, not from the answer', () => {
    withData({ searched: [{ title: 'OIB-Richtlinie 2', detail: 'S. 4' }, { title: 'Bauordnung für Wien' }], notRegulated: true }, NOT_FOUND)
    const panes = screen.getByTestId('not-found').querySelectorAll('[data-pane]')
    expect([...panes].map((pane) => pane.getAttribute('data-pane'))).toEqual(['searched', 'rule', 'decides'])
    expect(within(panes[0] as HTMLElement).getByTestId('searched-list')).toHaveTextContent('OIB-Richtlinie 2 · S. 4')
    expect(panes[0]).toHaveTextContent('Bauordnung für Wien')
    expect(panes[1]).toHaveTextContent('Außenwandbekleidungen')
    // The pane says „Entscheidet"; the sentence keeps only who.
    expect(panes[2]).toHaveTextContent('die Baubehörde im Einzelfall.')
    expect(panes[2]).not.toHaveTextContent('Entscheidet:')
  })

  it('says so when the turn recorded no search', () => {
    withData({ searched: [], notRegulated: true }, NOT_FOUND)
    expect(screen.getByText('No search recorded.')).toBeInTheDocument()
  })

  it('is plain content where the masthead does not say „Nicht geregelt"', () => {
    withData({ searched: [{ title: 'OIB-Richtlinie 2' }], notRegulated: false }, NOT_FOUND)
    expect(screen.queryByTestId('not-found')).toBeNull()
    expect(screen.queryByText('OIB-Richtlinie 2')).toBeNull()
    expect(screen.getByText(/Außenwandbekleidungen/)).toBeInTheDocument()
  })
})

describe(':::subsumption', () => {
  it('lays the argument out as Norm → Sachverhalt → Ergebnis', () => {
    withData(
      { project },
      [
        ':::subsumption',
        '> „Tragende Wände in Gebäudeklasse 4 sind in R 60 auszuführen." [1]',
        '',
        '- Gebäudeklasse :project[building_class]',
        '- Fluchtniveau :project[escape_level_m]',
        '',
        'Die Anforderung ist damit nicht erfüllt.',
        ':::',
      ].join('\n')
    )
    const steps = screen.getByTestId('subsumption').querySelectorAll('[data-part]')
    expect([...steps].map((step) => step.getAttribute('data-part'))).toEqual(['norm', 'facts', 'result'])
    expect(steps[0]).toHaveTextContent('Rule')
    expect(steps[1]).toHaveTextContent('GK 4')
    expect(steps[1]).toHaveTextContent('10,8 m')
    expect(within(steps[2] as HTMLElement).getByTestId('subsumption-status')).toHaveTextContent('nicht erfüllt')
  })
})

describe('quote stamps', () => {
  const QUOTE = '> „Wände sind in REI 90 auszuführen." [1]'

  it('says „Wortlaut belegt [N]" for a quote the server found verbatim', () => {
    withData({ quoteStamps: [{ text: 'Wände sind in REI 90 auszuführen.', status: 'verbatim', number: 1, page: 4, punkt: '3.1' }] }, QUOTE)
    const stamp = screen.getByTestId('quote-stamp')
    expect(stamp).toHaveAttribute('data-status', 'verbatim')
    expect(stamp).toHaveTextContent('Wording verified [1]')
    expect(stamp).toHaveTextContent('Pkt. 3.1 · S. 4')
  })

  it('sets a quote the server could not find as a paraphrase', () => {
    withData({ quoteStamps: [{ text: 'Wände sind in REI 90 auszuführen.', status: 'not_found' }] }, QUOTE)
    expect(screen.getByTestId('quote-stamp')).toHaveTextContent('Wording not verified')
    expect(document.querySelector('figure[data-excerpt]')).toHaveAttribute('data-paraphrase', 'true')
  })

  it('says nothing for a quote it could not check, or without a stamp', () => {
    withData({ quoteStamps: [{ text: 'Wände sind in REI 90 auszuführen.', status: 'unchecked' }] }, QUOTE)
    expect(screen.queryByTestId('quote-stamp')).toBeNull()
  })
})

describe(':::metrics layout', () => {
  const tiles = (count: number): string =>
    [':::metrics', ...Array.from({ length: count }, (_, index) => `- Kennzahl ${index + 1}: ${index + 1} m`), ':::'].join('\n')

  it.each([1, 2, 3, 4])('lays %i tiles out as one grid of that count', (count) => {
    render(<MarkdownRenderer content={tiles(count)} />)
    expect(screen.getByTestId('figure-grid')).toHaveAttribute('data-count', String(count))
    expect(screen.getAllByTestId('figure-tile')).toHaveLength(count)
  })
})

describe('print', () => {
  it('keeps every button out of paper and every disclosure in it', () => {
    const Wrap = ({ children }: { children: ReactNode }) => <AnswerDataProvider value={{ prefill: vi.fn() }}>{children}</AnswerDataProvider>
    render(
      <Wrap>
        <MarkdownRenderer content={`${ACTIONS}\n\n:::details[Herleitung]\nTabelle 2.\n:::`} />
      </Wrap>
    )
    expect(screen.getByTestId('prefill-button').className).toContain('print:hidden')
    const panel = screen.getByText('Tabelle 2.').closest('[data-slot="collapsible-content"]')
    expect(panel?.className).toContain('print:data-[state=closed]:block')
  })
})
