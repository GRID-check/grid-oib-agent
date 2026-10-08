import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ProductFeedbackReportView } from '@/lib/product-feedback/types'
import { FeedbackTriage, type FeedbackTriageClient } from './feedback-triage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function report(overrides: Partial<ProductFeedbackReportView> = {}): ProductFeedbackReportView {
  return {
    id: 'r1',
    kind: 'bug',
    status: 'new',
    message: 'The upload stops at 99 percent.',
    pagePath: '/app/projects/p1/files',
    context: { viewport: '1440×900' },
    allowContact: true,
    organizationId: 'org_nord',
    organizationName: 'Büro Nord',
    reporter: { userId: 'u1', name: 'Maria Huber', email: 'maria@buero.test' },
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
    ...overrides,
  }
}

let client: {
  list: ReturnType<typeof vi.fn<FeedbackTriageClient['list']>>
  get: ReturnType<typeof vi.fn<FeedbackTriageClient['get']>>
  triage: ReturnType<typeof vi.fn<FeedbackTriageClient['triage']>>
}

beforeEach(() => {
  client = {
    list: vi.fn<FeedbackTriageClient['list']>().mockResolvedValue({
      reports: [
        report(),
        report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.' }),
      ],
      counts: { new: 2, in_progress: 0, resolved: 0, dismissed: 0 },
      nextCursor: null,
    }),
    get: vi.fn<FeedbackTriageClient['get']>().mockResolvedValue(null),
    triage: vi.fn<FeedbackTriageClient['triage']>(),
  }
})

describe('FeedbackTriage', () => {
  test('opens on what nobody has looked at yet', async () => {
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findAllByTestId('feedback-report')).toHaveLength(2)
    expect(client.list).toHaveBeenCalledWith({ status: 'new', kind: undefined })
  })

  test('pins and marks the report an inbox row linked to, without listing it twice', async () => {
    client.get.mockResolvedValue(
      report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.' })
    )

    render(<FeedbackTriage canTriage client={client} focusReportId="r2" />)

    await waitFor(() => {
      const rows = screen.getAllByTestId('feedback-report')
      expect(rows.map((row) => row.dataset.reportId)).toEqual(['r2', 'r1'])
    })
  })

  test('offers the reply link only to a reporter who agreed to be contacted', async () => {
    client.list.mockResolvedValue({
      reports: [
        report({
          reporter: { userId: 'u1', name: 'Maria Huber', email: null },
          allowContact: false,
        }),
      ],
      counts: { new: 1, in_progress: 0, resolved: 0, dismissed: 0 },
      nextCursor: null,
    })

    render(<FeedbackTriage canTriage client={client} />)

    const row = await screen.findByTestId('feedback-report')
    expect(within(row).queryByRole('link', { name: /Reply by email/ })).not.toBeInTheDocument()
    expect(within(row).getByText('Does not want to be contacted')).toBeInTheDocument()
  })

  test('shows the status read-only to a reader who may not triage', async () => {
    render(<FeedbackTriage canTriage={false} client={client} />)

    const [row] = await screen.findAllByTestId('feedback-report')
    expect(within(row!).queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument()
    expect(within(row!).getByText('New')).toBeInTheDocument()
  })

  test('filters by status from the chips', async () => {
    const user = userEvent.setup()
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    await user.click(screen.getByRole('button', { name: /Resolved/ }))

    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ status: 'resolved', kind: undefined })
    )
  })

  test('a slow answer for the previous filter does not overwrite the current one', async () => {
    const user = userEvent.setup()
    let resolveSlow: (value: Awaited<ReturnType<FeedbackTriageClient['list']>>) => void = () =>
      undefined
    client.list
      .mockResolvedValueOnce({
        reports: [report()],
        counts: { new: 1, in_progress: 0, resolved: 1, dismissed: 1 },
        nextCursor: null,
      })
      // "Resolved": slow, answers last.
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      // "Dismissed": fast, answers first.
      .mockResolvedValueOnce({
        reports: [report({ id: 'r9', status: 'dismissed', message: 'Dismissed one.' })],
        counts: { new: 1, in_progress: 0, resolved: 1, dismissed: 1 },
        nextCursor: null,
      })
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findByText('The upload stops at 99 percent.')

    await user.click(screen.getByRole('button', { name: /Resolved/ }))
    await user.click(screen.getByRole('button', { name: /Dismissed/ }))
    await screen.findByText('Dismissed one.')

    resolveSlow({
      reports: [report({ id: 'r8', status: 'resolved', message: 'Stale resolved one.' })],
      counts: { new: 1, in_progress: 0, resolved: 1, dismissed: 1 },
      nextCursor: null,
    })
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3))
    expect(screen.queryByText('Stale resolved one.')).not.toBeInTheDocument()
    expect(screen.getByText('Dismissed one.')).toBeInTheDocument()
  })

  test('keeps the previous rows, marked busy, while a filter refetches', async () => {
    const user = userEvent.setup()
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    client.list.mockReturnValueOnce(new Promise(() => undefined))
    await user.click(screen.getByRole('button', { name: /Resolved/ }))

    expect(screen.getAllByTestId('feedback-report')).toHaveLength(2)
    expect(screen.getByTestId('section-refreshing')).toBeInTheDocument()
  })

  test('says so when the linked report cannot be found', async () => {
    client.get.mockRejectedValue(new Error('404'))
    render(<FeedbackTriage canTriage client={client} focusReportId="gone" />)

    expect(await screen.findByTestId('feedback-focus-missing')).toHaveTextContent(
      'The linked report was not found.'
    )
    expect(screen.getAllByTestId('feedback-report')).toHaveLength(2)
  })

  test('keeps the filters on screen when a filter has no reports', async () => {
    client.list.mockResolvedValue({
      reports: [],
      counts: { new: 0, in_progress: 0, resolved: 3, dismissed: 0 },
      nextCursor: null,
    })
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findByText('No feedback here')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Resolved/ })).toBeInTheDocument()
  })

  test('does not repeat the page subtitle as the card description', async () => {
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')
    expect(screen.queryByText(/What members report from inside Piloti/)).not.toBeInTheDocument()
  })
})
