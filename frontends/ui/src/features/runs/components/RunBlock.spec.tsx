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
import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
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

describe('RunBlock — the stand', () => {
  it.each([
    ['angelegt', emptyRunLedger('run-0', T0), 'Starting'],
    ['laeuft', researching(), 'Running'],
    ['wartet', setRunStatus(researching(), 'wartet', at(50)), 'Waiting for you'],
    ['fertig', finished('doc-1'), 'Done'],
    ['fehlgeschlagen', failed(), 'Failed'],
    ['abgebrochen', setRunStatus(researching(), 'abgebrochen', at(50)), 'Cancelled'],
    ['unterbrochen', setRunStatus(finished('doc-1'), 'unterbrochen', at(100)), 'Interrupted'],
  ] as const)('%s: the spoken word, the glyph and the title', (status, ledger, word) => {
    render(<RunBlock ledger={ledger} title={TITLE} />)
    const block = screen.getByTestId('run-block')
    expect(block).toHaveAttribute('data-status', status)
    // The word is SPOKEN once and shown once — in the status line, which for a
    // live run leads with the phase instead. A reader who cannot see the glyph
    // would otherwise never hear „Running".
    expect(screen.getByTestId('run-status-word')).toHaveTextContent(word)
    expect(screen.getByTestId(`run-glyph-${status}`)).toBeInTheDocument()
    expect(screen.getByTestId('run-title')).toHaveTextContent(TITLE)
  })

  it('falls back to „Task" when the result has no title', () => {
    render(<RunBlock ledger={researching()} />)
    expect(screen.getByTestId('run-title')).toHaveTextContent('Task')
  })

  it('leads the line with the phase while the run is going, and with the tallies behind it', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Researching · 2 rounds · 3 documents',
    )
  })

  it('leads the line with the word once the run is over, and says what to do next', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Done · report filed in Project › Reports',
    )
  })

  it('shows the total duration of a finished run from its own instants', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('1:40')
  })
})

describe('RunBlock — the track', () => {
  it('fills the phases behind the run and marks the one it is in', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const track = screen.getByTestId('run-track')
    // Planen done, Recherchieren under way, three to go.
    expect(track).toHaveAttribute('data-reached', '1')
    expect(track).toHaveAttribute('data-active', 'true')
    expect(track).toHaveAttribute('data-tone', 'moving')
    expect(track.querySelectorAll('span')).toHaveLength(5)
    expect(track.querySelector('[data-stage="planen"]')).toHaveAttribute('data-done', 'true')
    expect(track.querySelector('[data-stage="recherchieren"]')).not.toHaveAttribute('data-done')
  })

  it('takes a register only once something has been asserted', () => {
    const { rerender } = render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.getByTestId('run-track')).toHaveAttribute('data-tone', 'settled')

    rerender(<RunBlock ledger={failed()} title={TITLE} />)
    expect(screen.getByTestId('run-track')).toHaveAttribute('data-tone', 'stopped')
    // The walk stopped short: the segment ahead is an outline, not a fill.
    expect(screen.getByTestId('run-track')).toHaveAttribute('data-halted', 'true')

    rerender(<RunBlock ledger={setRunStatus(researching(), 'abgebrochen', at(50))} title={TITLE} />)
    expect(screen.getByTestId('run-track')).toHaveAttribute('data-tone', 'retired')
  })

  it('has nothing left to walk into once the run is filed', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    const track = screen.getByTestId('run-track')
    expect(track).toHaveAttribute('data-reached', '5')
    expect(track).not.toHaveAttribute('data-halted')
    expect(track).not.toHaveAttribute('data-active')
  })
})

describe('RunBlock — the body', () => {
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

  it('reports a finished phase as one act with its duration', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    const acts = screen.getByTestId('run-phase-acts')
    // `dt` and `dd` are laid out with a gap, so the text runs together — the
    // same shape the document history's acts have.
    expect(acts.querySelector('[data-phase="planen"]')).toHaveTextContent(
      /Planning\s*Research plan drawn up · 12 sec/,
    )
    // Recherchieren's account is the list of rounds above; repeating its tally
    // here would be the same number twice on one screen.
    expect(acts.querySelector('[data-phase="recherchieren"]')).toBeNull()
    // Nothing is claimed about phases the run has not reached.
    expect(acts.querySelector('[data-phase="pruefen"]')).toBeNull()
    expect(acts.querySelector('[data-phase="abgelegt"]')).toBeNull()
  })

  it('says what the checking phase is doing while it is live', () => {
    let ledger = closePhase(researching(), 'recherchieren', at(60))
    ledger = openPhase(ledger, 'pruefen', at(60))
    render(<RunBlock ledger={ledger} title={TITLE} />)
    expect(screen.getByTestId('run-phase-acts').querySelector('[data-phase="pruefen"]')).toHaveTextContent(
      'Checking citations against the sources',
    )
  })

  it('does not claim a stopped run is still checking', () => {
    render(<RunBlock ledger={failed()} title={TITLE} defaultOpen />)
    const acts = screen.getByTestId('run-phase-acts')
    expect(acts.querySelector('[data-phase="pruefen"]')).toBeNull()
  })
})

describe('RunBlock — the fold', () => {
  it('is collapsed by default once terminal, and the reader can open it', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    expect(screen.queryByTestId('run-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(TITLE) }))
    expect(screen.getByTestId('run-body')).toBeInTheDocument()
  })

  it('honours defaultOpen on a terminal run', () => {
    render(<RunBlock ledger={finished('doc-1')} title={TITLE} defaultOpen />)
    expect(screen.getByTestId('run-body')).toBeInTheDocument()
  })

  // A closing body stays mounted through its exit animation, so "folded" is
  // read off the trigger's own state rather than off the body's absence.
  const trigger = (): HTMLElement => screen.getByRole('button', { name: new RegExp(TITLE) })

  /** Past every queued move of a landing, with room to spare. */
  const LANDING_SETTLED_MS = 2000

  it('opens when the run starts waiting, even if the reader had folded it', () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    fireEvent.click(trigger())
    expect(trigger()).toHaveAttribute('data-state', 'closed')
    rerender(<RunBlock ledger={setRunStatus(live, 'wartet', at(50))} title={TITLE} />)
    // A question opens the block at once: there is nothing to watch finish,
    // and the round that asked it is inside.
    expect(trigger()).toHaveAttribute('data-state', 'open')
  })

  it('folds on its own when a live run it opened lands, once the stand has spoken', async () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    expect(trigger()).toHaveAttribute('data-state', 'open')
    rerender(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    // The landing is queued: the track's last segment, the glyph and the line
    // go first, and the body is still open while they do.
    expect(trigger()).toHaveAttribute('data-state', 'open')
    await waitFor(() => expect(trigger()).toHaveAttribute('data-state', 'closed'), {
      timeout: LANDING_SETTLED_MS,
    })
  })

  it('leaves a block the reader opened by hand open when the run lands', async () => {
    const live = researching()
    const { rerender } = render(<RunBlock ledger={live} title={TITLE} />)
    fireEvent.click(trigger())
    fireEvent.click(trigger())
    rerender(<RunBlock ledger={finished('doc-1')} title={TITLE} />)
    await new Promise((resolve) => setTimeout(resolve, LANDING_SETTLED_MS))
    expect(trigger()).toHaveAttribute('data-state', 'open')
  })
})

describe('RunBlock — the line and the affordances', () => {
  it('names the filing destination while starting, when the caller says it files', () => {
    render(<RunBlock ledger={emptyRunLedger('run-0', T0)} title={TITLE} projectId="p1" filesToProject />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Starting · result goes to the project',
    )
  })

  it('says only that the task was taken on when nothing will be filed', () => {
    render(<RunBlock ledger={emptyRunLedger('run-0', T0)} title={TITLE} />)
    const line = screen.getByTestId('run-status-line')
    expect(line).toHaveTextContent('Starting')
    expect(line).not.toHaveTextContent('project')
  })

  // The regression the default `!!projectId` caused: an escalated chat
  // question runs inside a project and files NOTHING, and was promised the
  // project anyway — then contradicted by its own `fertig` line.
  it('promises no destination for a run in a project that never claimed to file', () => {
    render(<RunBlock ledger={emptyRunLedger('run-0', T0)} title={TITLE} projectId="p1" />)
    expect(screen.getByTestId('run-status-line')).not.toHaveTextContent('project')
  })

  it('has no closing rows while running', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    expect(screen.queryByTestId('run-footer')).not.toBeInTheDocument()
  })

  it('waiting: the line says where to answer, and Answer focuses the composer', () => {
    const onAnswer = vi.fn()
    render(<RunBlock ledger={setRunStatus(researching(), 'wartet', at(50))} title={TITLE} onAnswer={onAnswer} />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Waiting for you · answer below in the thread',
    )
    fireEvent.click(screen.getAllByTestId('run-action-answer')[0]!)
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it('done with a file: the line names where it was filed, and Review is the action while unreviewed', () => {
    render(<RunBlock ledger={finished('doc-9')} title={TITLE} projectId="p1" reviewHref="/review" />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Done · report filed in Project › Reports',
    )
    expect(screen.getAllByTestId('run-action-review')[0]).toHaveAttribute('href', '/review')
    expect(screen.queryByTestId('run-action-open-report')).not.toBeInTheDocument()
  })

  it('done with a file and nothing else to offer: the way to the report IS the action', () => {
    // Never behind the chevron: the line has just said where the report is.
    render(<RunBlock ledger={finished('doc-9')} title={TITLE} projectId="p1" />)
    expect(screen.getByTestId('run-file-link')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
  })

  it('done inline: says the report is in the thread and offers no project link', () => {
    render(<RunBlock ledger={finished()} title={TITLE} projectId="p1" />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Done · the report is here in the thread',
    )
    expect(screen.queryByTestId('run-file-link')).not.toBeInTheDocument()
  })

  it('done and reviewed: Open report replaces Review, and the verdict is stated', () => {
    render(
      <RunBlock
        ledger={finished('doc-9')}
        title={TITLE}
        defaultOpen
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
        defaultOpen
        review={{ decision: 'rejected', reason: 'OIB 2.3 gilt hier, nicht 2.' }}
      />,
    )
    expect(screen.getByTestId('run-review')).toHaveTextContent('Sent back: OIB 2.3 gilt hier, nicht 2.')
    expect(screen.getByTestId('run-review')).toHaveAttribute('data-decision', 'rejected')
  })

  it('failed: the reason is in the line, what was done by then is in the body, Retry only when offered', () => {
    const onRetry = vi.fn()
    const { unmount } = render(<RunBlock ledger={failed()} title={TITLE} defaultOpen onRetry={onRetry} />)
    // The reason never hides behind the chevron: a failure the reader has to go
    // looking for is a failure nobody reads.
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Failed: Das Budget war aufgebraucht.',
    )
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
    render(
      <RunBlock
        ledger={setRunStatus(researching(), 'abgebrochen', at(50))}
        title={TITLE}
        defaultOpen
      />,
    )
    expect(screen.getByTestId('run-status-line')).toHaveTextContent(
      'Cancelled · stopped at your request',
    )
    expect(screen.getByTestId('run-completed-before')).toHaveTextContent('Done so far: Planning')
  })

  it('interrupted: says the report was written from what was there', () => {
    render(<RunBlock ledger={setRunStatus(finished('doc-1'), 'unterbrochen', at(100))} title={TITLE} />)
    expect(screen.getByTestId('run-status-line')).toHaveTextContent('written from what was there')
    expect(screen.queryByTestId('run-completed-before')).not.toBeInTheDocument()
  })
})

describe('RunBlock — stopping a run', () => {
  it('offers the quiet stop only while the run is going, and only when a caller hands one in', () => {
    const onCancel = vi.fn()
    const { unmount } = render(<RunBlock ledger={researching()} title={TITLE} onCancel={onCancel} />)
    expect(screen.getAllByTestId('run-action-cancel').length).toBeGreaterThan(0)
    unmount()

    render(<RunBlock ledger={finished('doc-9')} title={TITLE} onCancel={onCancel} />)
    expect(screen.queryByTestId('run-action-cancel')).not.toBeInTheDocument()
  })

  it('shows no stop at all when no caller offers one', () => {
    render(<RunBlock ledger={researching()} title={TITLE} />)
    expect(screen.queryByTestId('run-action-cancel')).not.toBeInTheDocument()
  })

  it('asks before it stops, and stops only on the confirmation', async () => {
    const onCancel = vi.fn()
    render(<RunBlock ledger={researching()} title={TITLE} onCancel={onCancel} />)

    fireEvent.click(screen.getAllByTestId('run-action-cancel')[0]!)
    expect(onCancel).not.toHaveBeenCalled()
    expect(await screen.findByText('Stop this task?')).toBeInTheDocument()
    expect(screen.getByText(/stays in the block/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('run-cancel-confirm'))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('leaves the run alone when the reader keeps it running', async () => {
    const onCancel = vi.fn()
    render(<RunBlock ledger={researching()} title={TITLE} onCancel={onCancel} />)

    fireEvent.click(screen.getAllByTestId('run-action-cancel')[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep running' }))
    await waitFor(() => expect(screen.queryByText('Stop this task?')).not.toBeInTheDocument())
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('a waiting run keeps Answer as its action and offers the stop beside it', () => {
    render(
      <RunBlock
        ledger={setRunStatus(researching(), 'wartet', at(50))}
        title={TITLE}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getAllByTestId('run-action-answer').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('run-action-cancel').length).toBeGreaterThan(0)
  })
})

describe('RunBlock — when the live view loses its line', () => {
  it('says the run goes on, while it is going', () => {
    const { rerender } = render(
      <RunBlock ledger={researching()} title={TITLE} live connection="reconnecting" />,
    )
    expect(screen.getByTestId('run-connection')).toHaveTextContent(
      'The live view lost its connection and is reconnecting. The task is still running.',
    )

    rerender(<RunBlock ledger={researching()} title={TITLE} live connection="lost" />)
    expect(screen.getByTestId('run-connection')).toHaveTextContent('reload to follow it again')
    expect(screen.getByTestId('run-connection')).toHaveAttribute('data-connection', 'lost')
  })

  it('says nothing while the line is up, and nothing once the run is over', () => {
    const { unmount } = render(<RunBlock ledger={researching()} title={TITLE} live connection="live" />)
    expect(screen.queryByTestId('run-connection')).not.toBeInTheDocument()
    unmount()

    // A finished run's dead stream is not news: there is nothing left to watch.
    render(<RunBlock ledger={finished('doc-9')} title={TITLE} connection="lost" />)
    expect(screen.queryByTestId('run-connection')).not.toBeInTheDocument()
  })
})
