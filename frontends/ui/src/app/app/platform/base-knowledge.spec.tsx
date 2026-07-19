import { render, screen, waitFor } from '@/test-utils'
import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BaseKnowledge } from './base-knowledge'
import type { KnowledgeBaseStatus } from '@/lib/knowledge/service'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

// The in-app PDF viewer pulls in an iframe/dialog we don't exercise here.
vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: () => <div data-testid="pdf-viewer" />,
}))

function file(overrides: Partial<KnowledgeBaseStatus['files'][number]>): KnowledgeBaseStatus['files'][number] {
  return {
    fileName: 'doc.pdf',
    state: 'ingested',
    origin: 'corpus',
    sizeBytes: 1024,
    chunkCount: 4,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: null,
    summary: null,
    docClass: 'sonstiges',
    ...overrides,
  }
}

const STATUS: KnowledgeBaseStatus = {
  collectionName: 'oib',
  collectionExists: true,
  collectionUpdatedAt: null,
  summary: {
    totalFiles: 3,
    ingested: 3,
    stale: 0,
    pending: 0,
    snapshot: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: 12,
  },
  files: [
    file({ fileName: 'oib-richtlinie-2.pdf', docClass: 'oib_richtlinie' }),
    file({ fileName: 'oenorm-b-1600.pdf', docClass: 'norm_extern' }),
    file({ fileName: 'sonstiges-notiz.pdf', docClass: 'sonstiges', origin: 'uploaded' }),
  ],
}

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

describe('BaseKnowledge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders the two grouped sections split by binding vs. other', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))

    render(<BaseKnowledge />)

    // Both section headers render.
    expect(await screen.findByText('Binding OIB foundations')).toBeInTheDocument()
    expect(screen.getByText('Further base documents')).toBeInTheDocument()

    // The OIB directive sits in the binding section; the ÖNORM + uploaded doc in
    // the other section.
    expect(screen.getByText('oib-richtlinie-2.pdf')).toBeInTheDocument()
    expect(screen.getByText('oenorm-b-1600.pdf')).toBeInTheDocument()
    // Dokumentart badge label surfaces (via SourceSignalChip).
    expect(screen.getAllByText(/OIB-Richtlinie \(verbindlich\)/).length).toBeGreaterThan(0)
  })

  test('the Dokumentart dropdown reflects the doc_class and PATCHes on change', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oenorm-b-1600.pdf')

    // The row's dropdown is pre-filled with the current class label.
    const trigger = screen.getByRole('combobox', { name: /Document type for oenorm-b-1600\.pdf/i })
    expect(trigger).toHaveTextContent('Norm (ÖNORM u.a.)')

    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Gesetz / Bauordnung' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oenorm-b-1600.pdf/doc-class') &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true)
    })

    // The PATCH body carries the new doc_class.
    const patchCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/doc-class') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ doc_class: 'gesetz' })
  })

  test('a repo-shipped (corpus) row exposes a delete action that calls the service on confirm', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents/') && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true, fileName: 'oib-richtlinie-2.pdf', mode: 'excluded' }))
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    // The corpus row (origin: 'corpus') carries a "Remove from corpus" action.
    await user.click(screen.getByRole('button', { name: 'Remove from corpus: oib-richtlinie-2.pdf' }))

    // The confirm dialog uses the corpus-specific wording; confirm it.
    await user.click(screen.getByRole('button', { name: 'Remove from corpus' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oib-richtlinie-2.pdf') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })

  test('the upload input accepts PDF and ZIP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    expect(input.accept).toContain('.pdf')
    expect(input.accept).toContain('.zip')
  })

  test('uploading a file posts to the corpus and starts background polling', async () => {
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents')) {
        return Promise.resolve(
          jsonResponse({
            status: 'pending',
            kind: 'file',
            fileName: 'new-doc.pdf',
            docClass: 'sonstiges',
            message: '',
            accepted: 1,
            rejected: 0,
            members: null,
          }),
        )
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    const pdf = new File(['%PDF-1.4'], 'new-doc.pdf', { type: 'application/pdf' })
    await user.upload(input, pdf)

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url === '/api/platform/knowledge/documents' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  test('a ZIP upload shows aggregate + per-file indexing progress', async () => {
    const zipBody = {
      status: 'pending',
      kind: 'zip',
      fileName: null,
      docClass: null,
      message: '',
      accepted: 2,
      rejected: 0,
      members: [
        { fileName: 'a.pdf', status: 'pending', docClass: 'sonstiges', reason: null },
        { fileName: 'b.pdf', status: 'pending', docClass: 'sonstiges', reason: null },
      ],
    }
    // Status snapshot where a.pdf has finished indexing but b.pdf hasn't appeared yet.
    const statusWithA: KnowledgeBaseStatus = {
      ...STATUS,
      files: [...STATUS.files, file({ fileName: 'a.pdf', origin: 'uploaded', docClass: 'sonstiges' })],
    }
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(zipBody))
      }
      return Promise.resolve(jsonResponse(statusWithA))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    const zip = new File(['PK'], 'bulk.zip', { type: 'application/zip' })
    await user.upload(input, zip)

    // Aggregate progress: a.pdf done, b.pdf still working → "1 of 2".
    const progress = await screen.findByTestId('knowledge-upload-progress')
    expect(progress).toHaveTextContent('Indexing 1 of 2')
    // Per-file rows surface inside the progress card, each with its live state.
    expect(within(progress).getByText('a.pdf')).toBeInTheDocument()
    expect(within(progress).getByText('b.pdf')).toBeInTheDocument()
    expect(within(progress).getByText('Indexed')).toBeInTheDocument()
    expect(within(progress).getByText('Indexing…')).toBeInTheDocument()
  })
})
