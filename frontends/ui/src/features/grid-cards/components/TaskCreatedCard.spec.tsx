/**
 * The `task_created` card — what it reports, and where its one link goes.
 *
 * Two things can go wrong with a card that only reports. The first is the
 * report itself being wrong: the kind, the deadline and „läuft" are the whole
 * of what a reader is told about work they cannot see, so each is pinned here,
 * including the absences — no deadline named, no conversation created.
 *
 * The second is the link, and it is the reason this file exists. The card's one
 * control pointed at `/chat/<id>` for as long as the card existed, a path with
 * no route behind it: the control 404'd, and nothing failed. The href is
 * therefore asserted as a STRING against the URL the sharing registry emits for
 * the same target, because that is the only property that catches it.
 *
 * Renders without an `I18nProvider`, so the dictionary falls back to `en`
 * (`src/i18n/context.tsx`) and the strings below are the English ones.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { TaskCreatedCard } from './TaskCreatedCard'

const TASK = {
  taskId: '00000000-0000-4000-8000-0000000000f1',
  kind: 'einreichcheck' as const,
  title: 'Einreichcheck: Bauansuchen Haus A',
  goal: 'Mach den Einreichcheck für das Bauansuchen bis Freitag',
  dueAt: '2026-09-18T23:59:59.999Z',
  conversationId: 's_00000000_0000_4000_8000_0000000000f2',
}

describe('TaskCreatedCard — what it reports', () => {
  it('names the kind, the goal and the deadline, and says the work is running', () => {
    render(<TaskCreatedCard {...TASK} />)

    expect(screen.getByText(TASK.title)).toBeInTheDocument()
    expect(screen.getByText(TASK.goal)).toBeInTheDocument()
    expect(screen.getByTestId('task-created-kind')).toHaveTextContent('Submission check')
    // The most important string on the card: the answer beside it must not
    // read as though the work is done.
    expect(screen.getByTestId('task-created-status')).toHaveTextContent('running')
    expect(screen.getByTestId('task-created-due')).toHaveTextContent('by Sep 18, 2026')
  })

  it('says nothing about a deadline nobody named', () => {
    render(<TaskCreatedCard {...TASK} dueAt={null} />)
    expect(screen.queryByTestId('task-created-due')).not.toBeInTheDocument()
  })

  it('renders no date rather than „Invalid Date" for a date it cannot read', () => {
    render(<TaskCreatedCard {...TASK} dueAt="not-a-date" />)
    expect(screen.queryByTestId('task-created-due')).not.toBeInTheDocument()
  })
})

describe('TaskCreatedCard — no link to a run that lives right here', () => {
  it('offers no conversation link: the run block follows the card in this thread', () => {
    // ADR-0062: the run is a message in the commissioning thread, so a link to
    // „the conversation" would open the one the reader is already in.
    render(<TaskCreatedCard {...TASK} />)
    expect(screen.queryByTestId('task-created-open')).not.toBeInTheDocument()
    render(<TaskCreatedCard {...TASK} conversationId={null} />)
    expect(screen.queryByTestId('task-created-open')).not.toBeInTheDocument()
  })
})
