import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import { describeQuarantineReason, type QuarantineReason } from '@/lib/upload-screening/quarantine'
import { QuarantineQueue } from './quarantine-queue'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const TERM: QuarantineReason = { kind: 'term', term: 'Honorarvereinbarung', count: 3, pages: [1, 4] }
const IBAN: QuarantineReason = { kind: 'iban', sample: 'AT61 •••• •••• •••• 3456', count: 2 }

const ITEMS = [
  {
    id: 'doc-1',
    filename: 'Honorar.pdf',
    scope: 'project',
    projectId: 'proj_1',
    conversationId: null,
    uploadedBy: 'user_01',
    quarantinedAt: '2026-09-30T10:00:00.000Z',
    verdict: { reasons: [TERM], checked: 'full' },
  },
  {
    id: 'doc-2',
    filename: 'Konten.xlsx',
    scope: 'archiv',
    projectId: null,
    conversationId: null,
    uploadedBy: 'user_02',
    quarantinedAt: '2026-09-29T10:00:00.000Z',
    verdict: { reasons: [IBAN], checked: 'partial' },
  },
  {
    id: 'doc-3',
    filename: 'Anhang.pdf',
    scope: 'session',
    projectId: null,
    conversationId: 'conv_1',
    uploadedBy: 'user_03',
    quarantinedAt: '2026-09-28T10:00:00.000Z',
    verdict: null,
  },
]

type Responder = (url: string, init?: RequestInit) => Response | undefined

function stubApi(items: unknown[] = ITEMS, override: Responder = () => undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const custom = override(url, init)
      if (custom) return custom
      if (url === '/api/quarantine') return Response.json({ items })
      if (url === '/api/projects') return Response.json([{ id: 'proj_1', name: 'Wohnbau Nord' }])
      if (url.endsWith('/quarantine/release')) return Response.json({ id: 'doc-1', status: 'pending', jobId: 'j1' })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    })
  )
}

const calledWith = (url: string, method: string): boolean =>
  vi.mocked(fetch).mock.calls.some(([called, init]) => called === url && init?.method === method)

describe('QuarantineQueue', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('renders each reason in the phrase the upload summary uses', async () => {
    stubApi()
    render(<QuarantineQueue />)
    const tFiles = createTranslator(en, 'files')
    const first = await screen.findByTestId('quarantine-row-doc-1')
    expect(within(first).getByText(describeQuarantineReason(TERM, tFiles))).toBeInTheDocument()
    expect(within(first).getByText('“Honorarvereinbarung” in the text · pages 1, 4')).toBeInTheDocument()
    const second = screen.getByTestId('quarantine-row-doc-2')
    expect(within(second).getByText(describeQuarantineReason(IBAN, tFiles))).toBeInTheDocument()
    // A partly checked scan says so; a verdict that could not be read says that.
    expect(within(second).getByText(en.files.screening.partial)).toBeInTheDocument()
    expect(within(screen.getByTestId('quarantine-row-doc-3')).getByText('Reason could not be read')).toBeInTheDocument()
  })

  it('says where each file was uploaded, by project name when it can', async () => {
    stubApi()
    render(<QuarantineQueue />)
    await waitFor(() =>
      expect(within(screen.getByTestId('quarantine-row-doc-1')).getByText(/Project Wohnbau Nord/)).toBeInTheDocument()
    )
    expect(within(screen.getByTestId('quarantine-row-doc-2')).getByText(/Office filing/)).toBeInTheDocument()
    expect(within(screen.getByTestId('quarantine-row-doc-3')).getByText(/Chat attachment/)).toBeInTheDocument()
  })

  // T4.2: the reviewer looks at the file from where they decide.
  it('links a project file and a Büroablage file to where they are filed, opened on them', async () => {
    stubApi()
    render(<QuarantineQueue />)
    expect(await screen.findByTestId('quarantine-open-doc-1')).toHaveAttribute(
      'href',
      '/app/projects/proj_1/files?doc=doc-1'
    )
    expect(screen.getByTestId('quarantine-open-doc-2')).toHaveAttribute('href', '/app/archiv?doc=doc-2')
    // A chat attachment has no per-file view.
    expect(screen.queryByTestId('quarantine-open-doc-3')).not.toBeInTheDocument()
  })

  it('release asks first, posts to the release endpoint, and removes the row', async () => {
    stubApi()
    render(<QuarantineQueue />)
    fireEvent.click(await screen.findByTestId('quarantine-release-doc-1'))
    expect(calledWith('/api/documents/doc-1/quarantine/release', 'POST')).toBe(false)
    expect(screen.getByRole('dialog')).toHaveTextContent(/language models see its content/)

    fireEvent.click(screen.getByTestId('quarantine-release-confirm'))
    await waitFor(() => expect(screen.queryByTestId('quarantine-row-doc-1')).not.toBeInTheDocument())
    expect(calledWith('/api/documents/doc-1/quarantine/release', 'POST')).toBe(true)
    expect(toast.success).toHaveBeenCalled()
    expect(screen.getByTestId('quarantine-row-doc-2')).toBeInTheDocument()
  })

  it.each([
    ['doc-1', '/api/documents/doc-1'],
    ['doc-2', '/api/archiv/documents/doc-2'],
    ['doc-3', '/api/session/documents/doc-3'],
  ])('delete of %s goes through its shelf route %s and removes the row', async (id, route) => {
    stubApi()
    render(<QuarantineQueue />)
    fireEvent.click(await screen.findByTestId(`quarantine-delete-${id}`))
    fireEvent.click(screen.getByTestId('quarantine-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId(`quarantine-row-${id}`)).not.toBeInTheDocument())
    expect(calledWith(route, 'DELETE')).toBe(true)
  })

  it('keeps the row when the delete is refused, and says why for a chat attachment', async () => {
    stubApi(ITEMS, (url, init) =>
      init?.method === 'DELETE' && url.startsWith('/api/session/') ? new Response(null, { status: 404 }) : undefined
    )
    render(<QuarantineQueue />)
    fireEvent.click(await screen.findByTestId('quarantine-delete-doc-3'))
    fireEvent.click(screen.getByTestId('quarantine-delete-confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only people in that chat can delete a chat attachment.'))
    expect(await screen.findByTestId('quarantine-row-doc-3')).toBeInTheDocument()
  })

  it('says a file whose reading ended without a verdict was not checked, rather than that its reason is unreadable', async () => {
    stubApi([{ ...ITEMS[2], id: 'doc-f', held: 'unscreened' }, ITEMS[2]])
    render(<QuarantineQueue />)
    const unscreened = await screen.findByTestId('quarantine-row-doc-f')
    expect(within(unscreened).getByText(en.organization.quarantine.unscreened)).toBeInTheDocument()
    expect(within(screen.getByTestId('quarantine-row-doc-3')).getByText(en.organization.quarantine.noReason)).toBeInTheDocument()
    expect(within(unscreened).getByTestId('quarantine-release-doc-f')).toBeInTheDocument()
  })

  it('shows an empty state when nothing waits', async () => {
    stubApi([])
    render(<QuarantineQueue />)
    expect(await screen.findByTestId('quarantine-empty')).toHaveTextContent('Nothing is waiting for review')
  })
})
