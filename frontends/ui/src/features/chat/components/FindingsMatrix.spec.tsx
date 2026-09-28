import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { en } from '@/i18n/dictionaries'
import type { Findings } from '@/lib/conversations/message-findings'
import { FindingsMatrix } from './FindingsMatrix'

const findings: Findings = {
  v: 1,
  items: [
    {
      requirement: 'Feuerwiderstand tragender Bauteile',
      value: 'REI 60',
      status: 'erfuellt',
      grounding: 'belegt',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', page: 12 },
      citations: [1],
      comment: 'Gilt für GK 4; im Kellergeschoß REI 90.',
    },
    { requirement: 'Zweiter Fluchtweg', status: 'offen', grounding: 'offen', citations: [] },
  ],
}

describe('FindingsMatrix', () => {
  test('one row per finding, the status in words and the count line in numbers', () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.getAllByTestId('finding-row')).toHaveLength(2)
    expect(screen.getByText(en.chat.findings.status.erfuellt)).toBeInTheDocument()
    expect(screen.getByText(en.chat.findings.status.offen)).toBeInTheDocument()
    expect(
      screen.getByText(`1 ${en.chat.findings.status.erfuellt} · 1 ${en.chat.findings.status.offen}`)
    ).toBeInTheDocument()
    expect(screen.getByText('REI 60')).toBeInTheDocument()
  })

  test('a table of rows without verdicts is headed Results, with no status column', () => {
    const results: Findings = {
      v: 1,
      items: [
        { requirement: 'Variante A', value: '12 m', grounding: 'belegt', citations: [1] },
        { requirement: 'Variante B', value: '15 m', grounding: 'belegt', citations: [2] },
      ],
    }
    render(<FindingsMatrix findings={results} anchorPrefix="src-" />)
    expect(screen.getByTestId('findings-matrix')).toHaveAttribute('data-judged', 'false')
    expect(screen.getByText(en.chat.findings.labelResults)).toBeInTheDocument()
    expect(screen.queryByText(en.chat.findings.columns.status)).not.toBeInTheDocument()
    expect(screen.getByText(en.chat.findings.columns.note)).toBeInTheDocument()
    expect(screen.queryByText(en.chat.findings.status.offen)).not.toBeInTheDocument()
  })

  test('the [N] jumps to the answer’s own sources row', () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.getByText('[1]').closest('a')).toHaveAttribute('href', '#src-1')
  })

  test('a row with a comment opens on click; a row without one does not', async () => {
    render(<FindingsMatrix findings={findings} anchorPrefix="src-" />)
    expect(screen.queryByTestId('finding-detail')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByTestId('finding-row')[0]!)
    expect(screen.getByText('Gilt für GK 4; im Kellergeschoß REI 90.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByTestId('finding-row')[1]!)
    expect(screen.getAllByTestId('finding-detail')).toHaveLength(1)
  })

  test('marks what changed against the previous report and names what was dropped', () => {
    const previous: Findings = {
      v: 1,
      items: [
        {
          requirement: 'Feuerwiderstand tragender Bauteile',
          value: 'REI 90',
          status: 'erfuellt',
          grounding: 'belegt',
          citations: [],
        },
        { requirement: 'Barrierefreiheit', status: 'erfuellt', grounding: 'belegt', citations: [] },
      ],
    }
    render(<FindingsMatrix findings={findings} previous={previous} />)
    const marks = screen.getAllByTestId('finding-change').map((chip) => chip.textContent)
    expect(marks).toEqual([en.chat.findings.change.changed, en.chat.findings.change.new])
    expect(screen.getByTestId('findings-dropped')).toHaveTextContent('Barrierefreiheit')
  })

  test('an open finding offers „Klären" and shows the receipt once the run is commissioned', async () => {
    const onCommission = vi.fn().mockResolvedValue(true)
    render(<FindingsMatrix findings={findings} onCommission={onCommission} />)
    expect(screen.getAllByTestId('finding-commission')).toHaveLength(1)
    await userEvent.setup().click(screen.getByTestId('finding-commission'))
    expect(onCommission).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: 'Zweiter Fluchtweg' })
    )
    expect(await screen.findByTestId('finding-commissioned')).toBeInTheDocument()
    expect(screen.queryByTestId('finding-commission')).not.toBeInTheDocument()
  })

  test('an unsourced finding says so beside its status', () => {
    render(<FindingsMatrix findings={findings} />)
    expect(screen.getByText(en.chat.findings.grounding.offen)).toBeInTheDocument()
  })
})
