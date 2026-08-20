/**
 * What the pane says while it has nothing to show — and what it does with the
 * bytes once it has them.
 *
 * The states are the point. A PDF takes a round trip to generate and can fail
 * at the far end of it, so "blank pane" is a real outcome the reader would
 * otherwise have to interpret. And the object URL is the other half: it is a
 * document-lifetime reference to the blob, so anything that forgets to revoke
 * one leaks the whole PDF, silently, for as long as the tab is open.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '@/features/chat/store'

const chat = vi.hoisted(() => ({
  state: {
    reportContent: '# Report\n\nBody',
    currentConversation: { title: 'Brandschutz OIB 2' },
  } as DeepPartial<ChatStoreWithHydration>,
  isBusy: false,
}))

vi.mock('@/features/chat', () => ({
  useChatStore: (selector?: StoreSelector<ChatStoreWithHydration>) =>
    selector
      ? selector(asStoreState<ChatStoreWithHydration>(chat.state))
      : chat.state,
  useIsCurrentSessionBusy: () => chat.isBusy,
}))
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }))

import { ReportPdfPreview } from './report-pdf-preview'

const pdfResponse = () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  blob: () => Promise.resolve(new Blob(['%PDF-1.7'], { type: 'application/pdf' })),
})

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

let created = 0

beforeEach(() => {
  created = 0
  chat.state = {
    reportContent: '# Report\n\nBody',
    currentConversation: { title: 'Brandschutz OIB 2' },
  }
  chat.isBusy = false
  global.URL.createObjectURL = vi.fn(() => `blob:report-${++created}`)
  global.URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pdfResponse()))
})

afterEach(() => {
  vi.unstubAllGlobals()
  global.URL.createObjectURL = originalCreateObjectURL
  global.URL.revokeObjectURL = originalRevokeObjectURL
})

describe('ReportPdfPreview — states', () => {
  test('generates the PDF from the report markdown and shows it in a frame', async () => {
    render(<ReportPdfPreview onClose={vi.fn()} />)

    expect(screen.getByText(/generating pdf/i)).toBeInTheDocument()

    const frame = await screen.findByTitle(/Brandschutz OIB 2/i)
    expect(frame).toHaveAttribute('src', 'blob:report-1')
    expect(global.fetch).toHaveBeenCalledWith('/api/generate-pdf', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ markdown: '# Report\n\nBody' }),
    }))
  })

  test('says there is no report yet rather than showing an empty frame', () => {
    chat.state = { reportContent: '   ', currentConversation: { title: 'Untitled' } }
    render(<ReportPdfPreview onClose={vi.fn()} />)

    expect(screen.getByText(/report content will appear here/i)).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('waits for the run to finish — a half-written report renders a half-written PDF', () => {
    chat.isBusy = true
    render(<ReportPdfPreview onClose={vi.fn()} />)

    expect(screen.getByText(/available when research is complete/i)).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('reports a generation failure in words, with the server’s own reason kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    )
    render(<ReportPdfPreview onClose={vi.fn()} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/preview couldn't be loaded/i)
    expect(alert).toHaveTextContent(/500 Internal Server Error/)
  })

  test('retries the generation on demand', async () => {
    const user = userEvent.setup()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' })
      .mockResolvedValue(pdfResponse())
    vi.stubGlobal('fetch', fetchMock)

    render(<ReportPdfPreview onClose={vi.fn()} />)
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByTitle(/Brandschutz OIB 2/i)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('closes through the pane’s own control', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ReportPdfPreview onClose={onClose} />)

    await user.click(screen.getByTestId('report-pdf-preview-close'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ReportPdfPreview — the object URL', () => {
  test('is revoked on unmount, because dropping the string frees nothing', async () => {
    const { unmount } = render(<ReportPdfPreview onClose={vi.fn()} />)
    await screen.findByTitle(/Brandschutz OIB 2/i)

    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report-1')
  })

  test('is replaced, and the old one revoked, when the report changes', async () => {
    const { rerender } = render(<ReportPdfPreview onClose={vi.fn()} />)
    await screen.findByTitle(/Brandschutz OIB 2/i)

    chat.state = {
      reportContent: '# Report\n\nRewritten',
      currentConversation: { title: 'Brandschutz OIB 2' },
    }
    rerender(<ReportPdfPreview onClose={vi.fn()} />)

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report-1'))
    const frame = await screen.findByTitle(/Brandschutz OIB 2/i)
    expect(frame).toHaveAttribute('src', 'blob:report-2')
  })
})
