/**
 * The run's message: the block from the hook's ledger, and the report beneath
 * it only once the run has produced one.
 */

import { render, screen } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../hooks/use-run-ledger', () => ({ useRunLedger: vi.fn() }))
vi.mock('./RunBlock', () => ({
  RunBlock: ({
    ledger,
    title,
    live,
    onCancel,
  }: {
    ledger: { status: string }
    title?: string | null
    live?: boolean
    onCancel?: (() => void) | null
  }) => (
    <div
      data-testid="run-block"
      data-status={ledger.status}
      data-live={live ? 'true' : undefined}
      data-cancellable={onCancel ? 'true' : undefined}
    >
      {title}
    </div>
  ),
}))

import type { ChatMessage } from '@/features/chat/types'
import type { RunLedger, RunStatus } from '@/lib/runs/run-ledger-types'
import { useRunLedger } from '../hooks/use-run-ledger'
import { RunBlockMessage } from './RunBlockMessage'

const ledger = (status: RunStatus): RunLedger => ({
  runId: 'run-1',
  status,
  phases: [],
  steps: [],
  startedAt: '2026-09-16T08:00:00.000Z',
  updatedAt: '2026-09-16T08:00:00.000Z',
})

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'assistant',
  content: '',
  timestamp: new Date('2026-09-16T08:00:00.000Z'),
  messageType: 'agent_response',
  runLedger: ledger('laeuft'),
  runTitle: 'Normprüfung: Fluchtwege',
  ...overrides,
})

const answer = <div data-testid="agent-response">Der Bericht</div>

describe('RunBlockMessage', () => {
  it('renders the block from the hook’s ledger with the message’s title', () => {
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('laeuft'),
      live: true,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })

    render(<RunBlockMessage message={message()} projectId="p1" answer={answer} />)

    expect(useRunLedger).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
    const block = screen.getByTestId('run-block')
    expect(block).toHaveAttribute('data-status', 'laeuft')
    expect(block).toHaveAttribute('data-live', 'true')
    expect(block).toHaveTextContent('Normprüfung: Fluchtwege')
    expect(screen.getByTestId('run-block-message')).toHaveAttribute('data-run-id', 'run-1')
  })

  it('hands the block the hook’s way to stop the run, and nothing when there is none', () => {
    const cancel = vi.fn()
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('laeuft'),
      live: true,
      cancel,
      writeNow: null,
      addDocument: null,
      connection: 'live',
    })

    const { unmount } = render(
      <RunBlockMessage message={message()} projectId="p1" answer={answer} />
    )
    expect(screen.getByTestId('run-block')).toHaveAttribute('data-cancellable', 'true')
    unmount()

    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('fertig'),
      live: false,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })
    render(<RunBlockMessage message={message()} projectId="p1" answer={answer} />)
    expect(screen.getByTestId('run-block')).not.toHaveAttribute('data-cancellable')
  })

  it('keeps the report out of sight while the run is still going', () => {
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('laeuft'),
      live: true,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })

    render(<RunBlockMessage message={message({ content: 'Der Bericht' })} answer={answer} />)

    expect(screen.queryByTestId('agent-response')).not.toBeInTheDocument()
  })

  it('renders the report beneath the block once the run is finished', () => {
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('fertig'),
      live: false,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })

    render(<RunBlockMessage message={message({ content: 'Der Bericht' })} answer={answer} />)

    const wrapper = screen.getByTestId('run-block-message')
    expect(wrapper.firstElementChild).toBe(screen.getByTestId('run-block'))
    expect(screen.getByTestId('agent-response')).toHaveTextContent('Der Bericht')
  })

  it('renders the report of an interrupted run too — the block says one was written', () => {
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('unterbrochen'),
      live: false,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })

    render(<RunBlockMessage message={message({ content: 'Der Bericht' })} answer={answer} />)

    expect(screen.getByTestId('agent-response')).toBeInTheDocument()
  })

  it('shows no empty answer card for a finished run whose message has no content', () => {
    vi.mocked(useRunLedger).mockReturnValue({
      ledger: ledger('fertig'),
      live: false,
      cancel: null,
      writeNow: null,
      addDocument: null,
      connection: null,
    })

    render(<RunBlockMessage message={message({ content: '   ' })} answer={answer} />)

    expect(screen.queryByTestId('agent-response')).not.toBeInTheDocument()
  })
})
