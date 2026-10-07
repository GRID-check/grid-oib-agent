/**
 * Closing with „Ausmisten" (ADR-0084): the proposal is labelled as an AI
 * proposal, every item can be deselected, only what stays selected goes to the
 * Papierkorb, and nothing is removed before the person confirms.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CleanupProposal } from '@/lib/projects/cleanup-types'
import { CloseProjectDialog } from './close-project-dialog'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

const proposal = (overrides: Partial<CleanupProposal> = {}): CleanupProposal => ({
  items: [
    { documentId: A, filename: 'Grundriss_v1.pdf', folderPath: 'Pläne', category: 'superseded', aiReason: 'Ältere Fassung.', rule: 'older-version' },
    { documentId: B, filename: '~$Baubeschreibung.docx', folderPath: null, category: 'temporary', aiReason: null, rule: 'lock-file' },
  ],
  considered: 12,
  aiUsed: true,
  aiError: null,
  ...overrides,
})

function stub(answer: CleanupProposal | null) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/projects/p1/cleanup') && (!init || !init.method || init.method === 'GET')) {
      return answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 502 })
    }
    return new Response(JSON.stringify({ removed: 1, binEntries: 1 }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const posted = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))

describe('CloseProjectDialog', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('labels the proposal as AI, with each reason, all selected, and removes nothing until confirmed', async () => {
    const fetchMock = stub(proposal())
    const onClose = vi.fn(async () => true)
    render(<CloseProjectDialog projectId="p1" open onOpenChange={() => {}} onClose={onClose} />)

    expect(await screen.findByTestId('cleanup-notice')).toHaveTextContent('AI proposal: made by Piloti')
    expect(screen.getByText('Ältere Fassung.')).toBeInTheDocument()
    expect(screen.getByText('Lock file of an Office program')).toBeInTheDocument()
    expect(screen.getAllByText('AI proposal')).toHaveLength(1)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(posted(fetchMock)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  test('the person overrides an item: only what stays selected goes to the Papierkorb, then it closes', async () => {
    const fetchMock = stub(proposal())
    const onClose = vi.fn(async () => true)
    render(<CloseProjectDialog projectId="p1" open onOpenChange={() => {}} onClose={onClose} />)

    await userEvent.click(await screen.findByLabelText(/Grundriss_v1\.pdf/))
    await userEvent.click(screen.getByRole('button', { name: 'Move 1 to the bin and close' }))

    expect(posted(fetchMock)).toEqual([{ documentIds: [B], proposedIds: [A, B], aiUsed: true }])
    expect(onClose).toHaveBeenCalled()
  })

  test('says when the AI check was unavailable and the rules stood in', async () => {
    stub(proposal({ aiUsed: false, aiError: 'backend_unreachable', items: proposal().items.slice(1) }))
    render(<CloseProjectDialog projectId="p1" open onOpenChange={() => {}} onClose={vi.fn(async () => true)} />)
    expect(await screen.findByTestId('cleanup-notice')).toHaveTextContent('The AI check was not available just now')
  })

  test('without a proposal, closing stays possible and removes nothing', async () => {
    const fetchMock = stub(null)
    const onClose = vi.fn(async () => true)
    render(<CloseProjectDialog projectId="p1" open onOpenChange={() => {}} onClose={onClose} />)

    expect(await screen.findByText('The proposals could not be loaded. You can still close the project.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close without removing anything' }))
    expect(posted(fetchMock)).toEqual([])
    expect(onClose).toHaveBeenCalled()
  })

  test('does not close when clearing out failed', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Response('{}', { status: 400 }) : new Response(JSON.stringify(proposal()), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn(async () => true)
    render(<CloseProjectDialog projectId="p1" open onOpenChange={() => {}} onClose={onClose} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Move 2 to the bin and close' }))
    expect(await screen.findByText('Clearing out did not work; the project is still open.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
