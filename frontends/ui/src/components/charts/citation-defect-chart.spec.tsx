import { render, screen } from '@/test-utils'
import { describe, expect, test } from 'vitest'
import { CitationDefectChart } from './citation-defect-chart'

/**
 * The chart stacks per-KIND turn counts, and those counts are not additive: one
 * turn that trips three checks contributes three segments. Labelling that stack
 * as a count of turns reported three bad turns in a window that only had one —
 * the exact contradiction that made the dashboard read as broken (0 % clean of
 * 1 turn, next to a bar claiming "3 turns"). These tests pin the units.
 */

const KINDS = ['citations_removed', 'answer_ungrounded', 'confidence_capped'] as const

const labels = {
  kindLabel: (kind: string) => kind,
  turnsLabel: (count: number) => `${count} turns`,
  findingsLabel: (count: number) => `${count} findings`,
  flaggedLabel: (count: number) => `${count} flagged`,
  emptyLabel: 'No citation findings in this window.',
  ariaLabel: 'Defects per day',
}

describe('CitationDefectChart', () => {
  test('labels the stack in findings, not turns, when one turn trips several checks', () => {
    render(
      <CitationDefectChart
        points={[
          {
            day: '2026-07-28',
            turns: 1,
            defectTurns: 1,
            byKind: { citations_removed: 1, answer_ungrounded: 1, confidence_capped: 1 },
          },
        ]}
        kinds={KINDS}
        {...labels}
      />,
    )

    expect(screen.getByText('3 findings')).toBeDefined()
    expect(screen.queryByText('3 turns')).toBeNull()
    expect(screen.getByRole('button', { name: 'Jul 28: 3 findings' })).toBeDefined()
  })

  test('renders the empty label when no kind carries a finding', () => {
    render(
      <CitationDefectChart
        points={[{ day: '2026-07-28', turns: 12, defectTurns: 0, byKind: {} }]}
        kinds={KINDS}
        {...labels}
      />,
    )

    expect(screen.getByText('No citation findings in this window.')).toBeDefined()
  })
})
