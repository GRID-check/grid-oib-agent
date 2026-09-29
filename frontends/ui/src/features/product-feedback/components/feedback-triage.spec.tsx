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
      reports: [report(), report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.' })],
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
    client.get.mockResolvedValue(report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.' }))

    render(<FeedbackTriage canTriage client={client} focusReportId="r2" />)

    await waitFor(() => {
      const rows = screen.getAllByTestId('feedback-report')
      expect(rows.map((row) => row.dataset.reportId)).toEqual(['r2', 'r1'])
    })
  })

  test('offers the reply link only to a reporter who agreed to be contacted', async () => {
    client.list.mockResolvedValue({
      reports: [report({ reporter: { userId: 'u1', name: 'Maria Huber', email: null }, allowContact: false })],
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

    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ status: 'resolved', kind: undefined }))
  })
})
