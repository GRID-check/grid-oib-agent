/**
 * The Laufblock — what each state says, shows and offers.
 *
 * Renders without an `I18nProvider`, so the dictionary falls back to `en` and
 * the words below are the English ones; the German is pinned by the dictionary
 * type, not by a second copy of these tests.
 *
 * Fixtures are built with the ledger's own fold helpers at fixed instants, so
 * a duration or a tally asserted here is a fact production would also render.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test-utils'
import {
  appendStep,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  setRunStatus,
} from '@/lib/runs/run-ledger'
import type { RunLedger, RunStep } from '@/lib/runs/run-ledger-types'
import { RunBlock } from './RunBlock'

const T0 = new Date('2026-09-16T08:00:00.000Z')
const at = (s: number): Date => new Date(T0.getTime() + s * 1000)

const ROUND_1: RunStep = {
  id: 'r1',
  phase: 'recherchieren',
  intent: 'Klären, welche Fluchtweglängen OIB 2 für Gebäudeklasse 4 vorsieht',
  startedAt: at(20).toISOString(),
  docs: [
    { name: 'OIB-Richtlinie 2', shelf: 'base', loci: ['Pkt. 4.2', 'S. 18'] },
    { name: 'Bauordnung für Wien § 108', shelf: 'base', loci: ['§ 108 Abs. 2'] },
  ],
}
const ROUND_2: RunStep = {
  id: 'r2',
  phase: 'recherchieren',
  intent: 'Prüfen, ob das Atrium als Treppenraum gilt',
  startedAt: at(45).toISOString(),
  docs: [
    { name: 'OIB-Richtlinie 2', shelf: 'base', loci: ['Pkt. 3.1'], repeat: true },
    { name: 'Grundriss EG', shelf: 'project', loci: ['Achse C–E'] },
  ],
  openPoints: ['Landesabweichung Wien prüfen'],
}

function researching(): RunLedger {
  let ledger = emptyRunLedger('run-1', T0)
  ledger = openPhase(ledger, 'planen', at(0))
  ledger = closePhase(ledger, 'planen', at(12))
  ledger = openPhase(ledger, 'recherchieren', at(12))
  ledger = appendStep(ledger, ROUND_1, at(20))
  ledger = appendStep(ledger, ROUND_2, at(45))
  return ledger
}

function finished(fileId?: string): RunLedger {
  let ledger = closePhase(researching(), 'recherchieren', at(90))
  for (const phase of ['pruefen', 'schreiben', 'abgelegt'] as const) {
    ledger = openPhase(ledger, phase, at(90))
    ledger = closePhase(ledger, phase, at(100))
  }
  return finishRun(ledger, { ...(fileId ? { fileId } : {}), filedAt: at(100).toISOString() }, at(100))
}

function failed(): RunLedger {
  let ledger = closePhase(researching(), 'recherchieren', at(60))
  ledger = openPhase(ledger, 'pruefen', at(60))
  return failRun(ledger, 'Das Budget war aufgebraucht.', at(70))
}

const TITLE = 'Brandschutzkonzept — Fluchtwege'

describe('RunBlock — the header', () => {
  it.each([
    ['angelegt', emptyRunLedger('run-0', T0), 'Starting'],
    ['laeuft', researching(), 'Running'],
    ['wartet', setRunStatus(researching(), 'wartet', at(50)), 'Waiting for you'],
    ['fertig', finished('doc-1'), 'Done'],
    ['fehlgeschlagen', failed(), 'Failed'],
    ['abgebrochen', setRunStatus(researching(), 'abgebrochen', at(50)), 'Cancelled'],
    ['unterbrochen', setRunStatus(finished('doc-1'), 'unterbrochen', at(100)), 'Interrupted'],
  ] as const)('%s: the bold word and its glyph', (status, ledger, word) => {
    render(<RunBlock ledger={ledger} title={TITLE} />)
    const block = screen.getByTestId('run-block')
    expect(block).toHaveAttribute('data-status', status)
    expect(screen.getByTestId('run-status-word')).toHaveTextContent(word)
    expect(screen.getByTestId(`run-glyph-${status}`)).toBeInTheDocument()
    expect(screen.getByTestId('run-title')).toHaveTextContent(TITLE)
  })

  it('falls back to „Task" when the result has no title', () => {
    render(<RunBlock ledger={researching()} />)
    expect(screen.getByTestId('run-title')).toHaveTextContent('Task')
  })

  it('summarises a live run as rounds · documents while open, and names the phase once folded', () => {
    // Open, the rail below carries the phase; folded, the header is all there is.
    render(<RunBlock ledger={researching()} title={TITLE} defaultOpen={false} />)
    expect(screen.getByTestId('run-summary')).toHaveTextContent('Researching · 2 rounds · 3 documents')
  })

  it('leaves the phase to the rail while the block is open', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    expect(screen.getByTestId('run-summary')).toHaveTextContent('2 rounds · 3 documents')
    expect(screen.getByTestId('run-summary')).not.toHaveTextContent('Researching')
  })

  it('drops the phase from the summary once the run is terminal and keeps the tallies', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.getByTestId('run-summary')).toHaveTextContent('2 rounds · 3 documents')
    expect(screen.getByTestId('run-summary')).not.toHaveTextContent('Researching')
  })

  it('shows the total duration of a finished run from its own instants', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('1:40')
  })
})

describe('RunBlock — the rail and the phase list', () => {
  it('is open while live and marks done, active and pending phases', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const rail = screen.getByRole('list', { name: 'Phases' })
    const items = within(rail).getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual([
      'done',
      'active',
      'pending',
      'pending',
      'pending',
    ])
    expect(items[1]).toHaveAttribute('aria-current', 'step')
  })

  it('lists only the phases with something to say; the rail names the pending ones', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const body = screen.getByTestId('run-body')
    expect(body.querySelector('[data-phase="planen"]')).not.toBeNull()
    expect(body.querySelector('[data-phase="recherchieren"]')).not.toBeNull()
    expect(body.querySelector('[data-phase="pruefen"]')).toBeNull()
    expect(body.querySelector('[data-phase="abgelegt"]')).toBeNull()
  })

  it('folds a done phase to one line with its duration', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const planen = screen.getByTestId('run-body').querySelector('[data-phase="planen"]')
    expect(planen).toHaveAttribute('data-state', 'done')
    expect(planen).toHaveTextContent('Planning · Research plan drawn up · 12 sec')
  })

  it('shows every research round with its intent, its documents and the open points', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const steps = screen.getAllByTestId('run-step')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toHaveTextContent('Round 1 · Klären, welche Fluchtweglängen OIB 2')
    expect(steps[0]).toHaveTextContent('OIB-Richtlinie 2 · Pkt. 4.2 · S. 18')
    expect(steps[0]).toHaveTextContent('Bauordnung für Wien § 108 · § 108 Abs. 2')
    expect(steps[1]).toHaveTextContent('already read')
    expect(screen.getByTestId('run-open-points')).toHaveTextContent('Open: Landesabweichung Wien prüfen')
  })

  it('badges an OIB document and a Bauordnung by their authority, in the law family', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const [first] = screen.getAllByTestId('run-step')
    expect(within(first!).getByText('OIB')).toBeInTheDocument()
    expect(within(first!).getByText('RIS')).toBeInTheDocument()
  })

  it('says what the checking phase is doing while it is live', () => {
    let ledger = closePhase(researching(), 'recherchieren', at(60))
    ledger = openPhase(ledger, 'pruefen', at(60))
    render(<RunBlock ledger={ledger} title={TITLE} />)
    expect(screen.getByTestId('run-live-line')).toHaveTextContent('Checking citations against the sources')
  })

  it('does not claim a stopped run is still checking', () => {
    render(<RunBlock ledger={failed()} title={TITLE} defaultOpen />)
    expect(screen.queryByTestId('run-live-line')).not.toBeInTheDocument()
    const rail = screen.getByRole('list', { name: 'Phases' })
    expect(within(rail).getAllByRole('listitem')[2]).toHaveAttribute('data-state', 'active')
  })
})

describe('RunBlock — the fold', () => {
  it('is collapsed by default once terminal, and the reader can open it', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.queryByTestId('run-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(screen.getByTestId('run-body')).toBeInTheDocument()
  })

  it('honours defaultOpen on a terminal run', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} defaultOpen />)
    expect(screen.getByTestId('run-body')).toBeInTheDocument()
  })

  // A closing body stays mounted through its exit animation, so "folded" is
  // read off the trigger's own state rather than off the body's absence.
  const trigger = (word: RegExp): HTMLElement => screen.getByRole('button', { name: word })

  it('opens when the run starts waiting, even if the reader had folded it', () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    fireEvent.click(trigger(/Running/))
    expect(trigger(/Running/)).toHaveAttribute('data-state', 'closed')
    rerender(<RunBlock ledger={setRunStatus(live, 'wartet', at(50))} title={TITLE} />)
    expect(trigger(/Waiting/)).toHaveAttribute('data-state', 'open')
  })

  it('folds on its own when a live run it opened lands', () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    expect(trigger(/Running/)).toHaveAttribute('data-state', 'open')
    rerender(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(trigger(/Done/)).toHaveAttribute('data-state', 'closed')
  })

  it('leaves a block the reader opened by hand open when the run lands', () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    fireEvent.click(trigger(/Running/))
    fireEvent.click(trigger(/Running/))
    rerender(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(trigger(/Done/)).toHaveAttribute('data-state', 'open')
  })
})

describe('RunBlock — the sentence and the affordances', () => {
  it('names the filing destination while starting, when the run files to a project', () => {
    render(<RunBlock ledger={emptyRunLedger('run-0', T0)} title={TITLE} projectId="p1" />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('filed in the project under “Reports”')
  })

  it('says only that the task was taken on when nothing will be filed', () => {
    render(<RunBlock ledger={emptyRunLedger('run-0', T0)} title={TITLE} />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('Piloti is taking on the task.')
    expect(screen.getByTestId('run-sentence')).not.toHaveTextContent('filed')
  })

  it('has no footer while running', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    expect(screen.queryByTestId('run-footer')).not.toBeInTheDocument()
  })

  it('waiting: the sentence, and Answer when the composer can be focused', () => {
    const onAnswer = vi.fn()
    render(<RunBlock ledger={setRunStatus(researching(), 'wartet', at(50))} title={TITLE} onAnswer={onAnswer} />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('Piloti has a question.')
    fireEvent.click(screen.getAllByTestId('run-action-answer')[0]!)
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it('done with a file: the filing sentence, the project link, and Review while unreviewed', () => {
    render(<RunBlock ledger={finished('doc-9')} title={TITLE} projectId="p1" reviewHref="/review" />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('Report filed in Project › Reports.')
    expect(screen.getByTestId('run-file-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-9')
    expect(screen.getAllByTestId('run-action-review')[0]).toHaveAttribute('href', '/review')
    expect(screen.queryByTestId('run-action-open-report')).not.toBeInTheDocument()
  })

  it('done inline: says the report is in the thread and offers no project link', () => {
    render(<RunBlock ledger={finished()} title={TITLE} projectId="p1" />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('The report is here in the thread.')
    expect(screen.queryByTestId('run-file-link')).not.toBeInTheDocument()
  })

  it('done and reviewed: Open report replaces Review, and the verdict is stated', () => {
    render(
      <RunBlock
        ledger={finished('doc-9')}
        title={TITLE}
        review={{ decision: 'accepted', by: 'Anna Berger' }}
        reviewHref="/review"
        reportHref="/report"
      />,
    )
    expect(screen.getAllByTestId('run-action-open-report')[0]).toHaveAttribute('href', '/report')
    expect(screen.queryByTestId('run-action-review')).not.toBeInTheDocument()
    expect(screen.getByTestId('run-review')).toHaveTextContent('Accepted by Anna Berger')
  })

  it('states a rejection in the reviewer’s own words', () => {
    render(
      <RunBlock
        ledger={finished('doc-9')}
        title={TITLE}
        review={{ decision: 'rejected', reason: 'OIB 2.3 gilt hier, nicht 2.' }}
      />,
    )
    expect(screen.getByTestId('run-review')).toHaveTextContent('Sent back: OIB 2.3 gilt hier, nicht 2.')
    expect(screen.getByTestId('run-review')).toHaveAttribute('data-decision', 'rejected')
  })

  it('failed: the reason, what was done by then with the research tallies, and Retry only when offered', () => {
    const onRetry = vi.fn()
    const { unmount } = render(<RunBlock ledger={failed()} title={TITLE} onRetry={onRetry} />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('Failed: Das Budget war aufgebraucht.')
    expect(screen.getByTestId('run-completed-before')).toHaveTextContent(
      'Done so far: Planning, Researching (2 rounds, 3 documents)',
    )
    fireEvent.click(screen.getAllByTestId('run-action-retry')[0]!)
    expect(onRetry).toHaveBeenCalledTimes(1)
    unmount()

    render(<RunBlock ledger={failed()} title={TITLE} />)
    expect(screen.queryByTestId('run-action-retry')).not.toBeInTheDocument()
  })

  it('cancelled: stopped at your request, and what was done by then', () => {
    render(<RunBlock ledger={setRunStatus(researching(), 'abgebrochen', at(50))} title={TITLE} />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('Stopped at your request.')
    expect(screen.getByTestId('run-completed-before')).toHaveTextContent('Done so far: Planning')
  })

  it('interrupted: says the report was written from what was there', () => {
    render(<RunBlock ledger={setRunStatus(finished('doc-1'), 'unterbrochen', at(100))} title={TITLE} />)
    expect(screen.getByTestId('run-sentence')).toHaveTextContent('written from what was there')
    expect(screen.queryByTestId('run-completed-before')).not.toBeInTheDocument()
  })
})
