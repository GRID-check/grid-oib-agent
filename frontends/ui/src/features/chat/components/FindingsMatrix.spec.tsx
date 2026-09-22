import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
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

  test('an unsourced finding says so beside its status', () => {
    render(<FindingsMatrix findings={findings} />)
    expect(screen.getByText(en.chat.findings.grounding.offen)).toBeInTheDocument()
  })
})
