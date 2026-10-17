/**
 * Leaving the review keeps the reader's place: the inline viewer, which steps
 * aside while the review is open, opens again at the page the reader was on
 * in the review, not at the first one.
 *
 * The viewer and the review are stand-ins: what is pinned is the pane's side,
 * the page it hands the viewer once the review closes.
 */

import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import type * as ReviewModule from './review/document-review'
import { FilePreviewPane } from './file-preview-pane'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams('doc=doc-1'),
}))

vi.mock('@/features/knowledge/components/pdf-document-view', () => ({
  PdfDocumentView: ({ page, toolbarLead }: { page?: number | null; toolbarLead?: ReactNode }) => (
    <div data-testid="inline-viewer" data-page={page ?? ''}>
      {toolbarLead}
    </div>
  ),
}))

type ReviewModeProps = ComponentProps<typeof ReviewModule.DocumentReviewMode>
vi.mock('./review/document-review', async (importOriginal) => {
  const actual = await importOriginal<typeof ReviewModule>()
  return {
    ...actual,
    DocumentReviewMode: (props: ReviewModeProps) =>
      props.open ? (
        <div data-testid="review-mode">
          <button type="button" onClick={() => props.onPage?.(2)}>
            read page 2
          </button>
          <button type="button" onClick={() => props.onPage?.(3)}>
            read page 3
          </button>
          <button type="button" onClick={() => props.onOpenChange(false)}>
            close review
          </button>
        </div>
      ) : null,
  }
})

const FILE = {
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 1048576,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body }) as Response

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/annotations')) return json({ annotations: [], canAnnotate: true, pilotiWakes: false })
    if (url.endsWith('/preview')) return json({ url: 'https://example.test/plan.pdf', contentType: 'application/pdf' })
    return json({}, 404)
  })
  // The well mounts its viewer once it has been on screen.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('closing the review', () => {
  it('opens the inline viewer at the page the reader was on in the review', async () => {
    render(<FilePreviewPane file={FILE} projectId="proj-1" />)
    expect((await screen.findByTestId('inline-viewer')).dataset.page).toBe('')

    fireEvent.click(await screen.findByRole('button', { name: 'Open review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'read page 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'read page 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'close review' }))

    expect((await screen.findByTestId('inline-viewer')).dataset.page).toBe('3')
  })
})
