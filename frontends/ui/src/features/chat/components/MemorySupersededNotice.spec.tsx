/**
 * A correction, said out loud in the transcript (ADR-0055, C5).
 *
 * Until the wire carried `supersedes` this component was written and dark: it
 * rendered nothing, because the field was dropped on write, and the only place
 * a reader could see that Piloti had corrected itself was the memory panel.
 * These cases are what would go quiet again if that field stopped arriving.
 *
 * The rule worth a test is the one that looks like a bug: undo does NOT delete
 * the notice, and a 409 is not a failure — it is a statement about the store.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySupersededNotice, MemorySupersededNotices } from './MemorySupersededNotice'
import type { TurnMemoryItem } from '../lib/turn-memory'

const RETIRED = { id: 'row-0', content: 'The top escape level is 6.50 m.' }

const corrected = (): TurnMemoryItem & { supersedes: { id: string; content: string } } => ({
  id: 'row-1',
  kind: 'derived_fact',
  content: 'The top escape level is 9.80 m.',
  provenance: 'distillation',
  supersedes: RETIRED,
})

const added = (): TurnMemoryItem => ({
  id: 'row-2',
  kind: 'decision',
  content: 'A flat roof was chosen.',
  provenance: 'distillation',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A `fetch` that answers once with the given status. */
const answering = (status: number) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('what the reader is told', () => {
  it('states BOTH notes, which is what makes the correction checkable', () => {
    render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)

    expect(screen.getByText('Piloti replaced an earlier note.')).toBeInTheDocument()
    expect(screen.getByText(/The top escape level is 6\.50 m\./)).toBeInTheDocument()
    expect(screen.getByText(/The top escape level is 9\.80 m\./)).toBeInTheDocument()
  })

  it('renders one notice per supersession and none for an ordinary write', () => {
    render(<MemorySupersededNotices items={[added(), corrected()]} projectId="proj-1" />)

    expect(screen.getAllByTestId('memory-superseded-notice')).toHaveLength(1)
    expect(screen.queryByText(/A flat roof was chosen\./)).toBeNull()
  })

  it('renders nothing at all when this turn corrected nothing', () => {
    const { container } = render(<MemorySupersededNotices items={[added()]} projectId="proj-1" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the undo', () => {
  it('asks the restore route for the RETIRED note, not the one that replaced it', async () => {
    const fetchMock = answering(200)
    render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-1/memory/row-0/restore', {
      method: 'POST',
    })
    expect(screen.getByText('The earlier note is in force again.')).toBeInTheDocument()
  })

  it('leaves the notice standing once undone — the supersession HAPPENED', async () => {
    answering(200)
    render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(screen.getByTestId('memory-superseded-notice')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('reads a 409 as a statement about the store, not a failure', async () => {
    // The note is already back, or another writer moved the pair. Saying "that
    // could not be undone" would invite a second press at a store that is
    // already in the asked-for state.
    answering(409)
    render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(
      screen.getByText('Something changed here in the meantime — memory holds the current state.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('keeps the control when the undo itself failed, so a retry is one press away', async () => {
    answering(500)
    render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(screen.getByText('That could not be undone just now.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('states the correction without an undo when there is no project to restore in', () => {
    // A Büro turn has no project route to call. The statement is still strictly
    // more than the reader had before.
    render(<MemorySupersededNotice item={corrected()} projectId={null} />)

    expect(screen.getByTestId('memory-superseded-notice')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})

it('reports politely — it must not interrupt a streaming answer', () => {
  render(<MemorySupersededNotice item={corrected()} projectId="proj-1" />)
  const notice = screen.getByTestId('memory-superseded-notice')
  expect(notice).toHaveAttribute('role', 'status')
  expect(notice).toHaveAttribute('aria-live', 'polite')
})
