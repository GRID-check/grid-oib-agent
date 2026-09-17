/**
 * The compact line — the same word, glyph and tallies as the block's header,
 * in one row, plus the one link into the thread.
 *
 * Renders without an `I18nProvider`, so the words are the English ones.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { appendStep, emptyRunLedger, openPhase, setRunStatus } from '@/lib/runs/run-ledger'
import type { RunLedger } from '@/lib/runs/run-ledger-types'
import { RunBlockLine } from './RunBlockLine'

const T0 = new Date('2026-09-16T08:00:00.000Z')

function researched(): RunLedger {
  let ledger = openPhase(emptyRunLedger('run-1', T0), 'recherchieren', T0)
  ledger = appendStep(
    ledger,
    {
      id: 'r1',
      phase: 'recherchieren',
      intent: 'Fluchtweglängen klären',
      startedAt: T0.toISOString(),
      docs: [
        { name: 'OIB-Richtlinie 2', loci: ['S. 12'] },
        { name: 'Bauordnung für Wien § 108', loci: ['§ 108'] },
      ],
    },
    T0,
  )
  return ledger
}

describe('RunBlockLine', () => {
  it('reads status · title · tallies, and links into the thread', () => {
    render(
      <RunBlockLine
        ledger={researched()}
        title="Brandschutzkonzept — Fluchtwege"
        href="/app/chat?session=s1&run=run-1#message-m1"
      />,
    )
    const line = screen.getByTestId('run-block-line')
    expect(line).toHaveAttribute('data-status', 'laeuft')
    expect(screen.getByTestId('run-line-status')).toHaveTextContent('Running')
    expect(line).toHaveTextContent('Running · Brandschutzkonzept — Fluchtwege · 1 round · 2 documents')
    expect(screen.getByTestId('run-glyph-laeuft')).toBeInTheDocument()
    expect(screen.getByTestId('run-line-open')).toHaveAttribute(
      'href',
      '/app/chat?session=s1&run=run-1#message-m1',
    )
  })

  it('shows no tallies for a run that has reached nothing yet, and no link without an href', () => {
    render(<RunBlockLine ledger={emptyRunLedger('run-0', T0)} title="Aktenvermerk" />)
    const line = screen.getByTestId('run-block-line')
    expect(line).toHaveTextContent('Starting · Aktenvermerk')
    expect(line).not.toHaveTextContent('round')
    expect(screen.queryByTestId('run-line-open')).not.toBeInTheDocument()
  })

  it('takes the status it is given over the ledger’s, and a word for a row with no ledger', () => {
    const { unmount } = render(
      <RunBlockLine ledger={setRunStatus(researched(), 'wartet', T0)} status="fertig" title="A" />,
    )
    expect(screen.getByTestId('run-glyph-fertig')).toBeInTheDocument()
    unmount()

    render(<RunBlockLine ledger={null} status="fehlgeschlagen" title="B" />)
    expect(screen.getByTestId('run-line-status')).toHaveTextContent('Failed')
    expect(screen.getByTestId('run-glyph-fehlgeschlagen')).toBeInTheDocument()
  })

  it('takes tallies it is given, and reads without a title inside a surface that names the run', () => {
    render(<RunBlockLine ledger={null} status="fertig" tallies={{ rounds: 3, docs: 9 }} />)
    const line = screen.getByTestId('run-block-line')
    // No ledger, no title: the word, then the tallies straight after it.
    expect(line).toHaveTextContent(/^Done · 3 rounds · 9 documents$/)
  })

  it('dates the row with a <time> that carries the instant', () => {
    render(<RunBlockLine ledger={researched()} title="A" at="2026-09-16T05:00:00.000Z" />)
    expect(screen.getByTestId('run-block-line').querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-09-16T05:00:00.000Z',
    )
  })
})
