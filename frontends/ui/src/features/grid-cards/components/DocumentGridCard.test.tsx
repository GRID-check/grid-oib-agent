/**
 * Render tests for the DocumentGridCard — the chat surfacing card that presents
 * REAL project/Büroarchiv files. Focus: surfaced file names resolve to their
 * live document rows (project + Archiv), the card shows the human summary
 * (never the retrieval snippet / score), and a file that no longer resolves
 * degrades to a lean "not available" card instead of vanishing or crashing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { DocumentGridCard } from './DocumentGridCard'
import { resetSurfacedDocumentsCache } from '@/features/documents/hooks/use-surfaced-documents'
import { resetThumbnailCache } from '@/features/documents/components/file-card'
import { resetFilePeekBinding } from '@/features/documents/lib/open-file-peek'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { useChatStore } from '@/features/chat/store'

function row(id: string, filename: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename,
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    ...extra,
  }
}

afterEach(() => {
  resetSurfacedDocumentsCache()
  resetThumbnailCache()
  resetFilePeekBinding()
  useFilePreviewStore.setState({ file: null, hidden: false, mode: 'modal', context: {} })
  useChatStore.setState({ composerSubject: null })
})

describe('DocumentGridCard', () => {
  it('resolves surfaced files to project + Archiv rows and shows the human summary', async () => {
    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [row('p1', 'Fluchtwegplan.pdf', { summary: 'Fluchtwegplan EG mit zweitem Ausgang.' })],
        }),
      ),
      http.get('/api/archiv/documents', () =>
        HttpResponse.json({
          documents: [row('a1', 'Referenzprojekt.pdf', { summary: 'Vergleichbarer Grundriss aus dem Archiv.' })],
          collectionName: 'archiv_o',
          canManage: false,
        }),
      ),
      // Thumbnails fail → deterministic SVG sketch fallback (no backend needed).
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
    )

    render(
      <DocumentGridCard
        title="Relevante Dokumente – Fluchtwege"
        query="Fluchtwege"
        projectId="proj-1"
        documents={[
          {
            file_name: 'Fluchtwegplan.pdf',
            snippet: '[DRAWING from page 1] ZEICHNUNGSTYP: Fluchtwegplan',
            page: 2,
            score: 0.83,
            source: 'projekt',
          },
          { file_name: 'Referenzprojekt.pdf', snippet: 'Ähnlicher Grundriss…', page: null, score: 0.6, source: 'buero' },
        ]}
      />,
    )

    await waitFor(() =>
      expect(screen.getByText('Relevante Dokumente – Fluchtwege')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('document-grid-card')).toHaveAttribute('data-layout', 'choice')

    await waitFor(() => expect(screen.getByText('Fluchtwegplan.pdf')).toBeInTheDocument())
    expect(screen.getByText('Referenzprojekt.pdf')).toBeInTheDocument()
    expect(screen.getByText('Fluchtwegplan EG mit zweitem Ausgang.')).toBeInTheDocument()
    expect(screen.getByText('Vergleichbarer Grundriss aus dem Archiv.')).toBeInTheDocument()
    // Ranking leftovers stay off the card — they belong in Files search.
    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
    expect(screen.queryByText(/DRAWING from page/)).not.toBeInTheDocument()
    expect(screen.queryByText('83%')).not.toBeInTheDocument()
    expect(screen.queryByText('60%')).not.toBeInTheDocument()
    expect(screen.queryByText(/2\.4 MB|1 KB|yesterday/i)).not.toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Office')).toBeInTheDocument()
  })

  it('degrades an unresolvable file to an honest, actionable card (not a dead tile)', async () => {
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [] })),
      // 403 = feature gate, fail-open — NOT a fetch error, so no retry state.
      http.get('/api/archiv/documents', () => HttpResponse.json({}, { status: 403 }))
    )

    render(
      <DocumentGridCard
        title="Dokumente"
        documents={[{ file_name: 'Verschwunden.pdf', snippet: 'war mal da', source: 'projekt' }]}
        projectId="proj-1"
      />
    )

    await waitFor(() => expect(screen.getByText('Verschwunden.pdf')).toBeInTheDocument())
    // Honest explanation + a REAL action linking into the project files.
    expect(screen.getByText('The assistant referenced this file.')).toBeInTheDocument()
    const link = screen.getByTestId('document-grid-unresolved')
    expect(link).toHaveAttribute('href', '/app/projects/proj-1/files')
    expect(screen.getByText('Open in project files')).toBeInTheDocument()
    // Not the old dead "no longer available" grey box.
    expect(screen.queryByText('No longer available')).not.toBeInTheDocument()
  })

  it('shows a retry affordance (not dead tiles) when the resolve fetch genuinely fails', async () => {
    let projectCalls = 0
    server.use(
      http.get('/api/documents', () => {
        projectCalls += 1
        // First load fails (5xx = genuine error); the retry succeeds.
        return projectCalls === 1
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({ documents: [row('p1', 'Fluchtwegplan.pdf')] })
      }),
      http.get('/api/archiv/documents', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 }))
    )

    render(
      <DocumentGridCard
        title="Dokumente"
        documents={[{ file_name: 'Fluchtwegplan.pdf', source: 'projekt' }]}
        projectId="proj-1"
      />
    )

    // Genuine failure → retry state, never a permanent dead tile.
    await waitFor(() => expect(screen.getByTestId('document-grid-error')).toBeInTheDocument())
    expect(screen.getByText('Documents couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.queryByTestId('document-grid-unresolved')).not.toBeInTheDocument()

    // Retrying refetches and now resolves the file.
    await userEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.getByText(/Fluchtwegplan\.pdf/)).toBeInTheDocument())
    expect(screen.getByTestId('document-grid-card')).toHaveAttribute('data-layout', 'receipt')
    expect(screen.queryByTestId('document-grid-error')).not.toBeInTheDocument()
  })

  it('renders nothing when there are no documents', () => {
    const { container } = render(<DocumentGridCard title="Leer" documents={[]} projectId="proj-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('one file is a receipt that peeks; several files stay a choice', async () => {
    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json({ documents: [row('p1', 'Plan.dwg', { contentType: 'application/acad' })] })
      ),
      http.get('/api/archiv/documents', () => HttpResponse.json({}, { status: 403 })),
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
      http.get('/api/documents/:id/visual-details', () => HttpResponse.json({ details: [] }))
    )

    render(
      <DocumentGridCard title="CAD" documents={[{ file_name: 'Plan.dwg', source: 'projekt' }]} projectId="proj-1" />
    )

    await waitFor(() => expect(screen.getByTestId('document-grid-card')).toHaveAttribute('data-layout', 'receipt'))
    expect(screen.getByText(/Plan\.dwg/)).toBeInTheDocument()
    await waitFor(() => expect(useFilePreviewStore.getState().file?.filename).toBe('Plan.dwg'))
    await userEvent.click(screen.getByText(/Plan\.dwg/))
    expect(useFilePreviewStore.getState().file?.filename).toBe('Plan.dwg')
  })

  it('does NOT cross corpora when the backend tagged a source (avoids opening a same-named file)', async () => {
    // Same filename in BOTH corpora; the surfaced hit is tagged 'buero' but the
    // Archiv list is empty — it must resolve to nothing, never the project file.
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [row('p1', 'Bericht.pdf')] })),
      http.get('/api/archiv/documents', () => HttpResponse.json({ documents: [] }))
    )

    render(
      <DocumentGridCard
        title="Test"
        documents={[{ file_name: 'Bericht.pdf', source: 'buero' }]}
        projectId="proj-1"
      />
    )

    await waitFor(() => expect(screen.getByText('Bericht.pdf')).toBeInTheDocument())
    // Resolved to nothing → honest unresolved card linking to the ARCHIV (buero
    // source), never the same-named project file's card.
    expect(screen.getByText('The assistant referenced this file.')).toBeInTheDocument()
    expect(screen.getByTestId('document-grid-unresolved')).toHaveAttribute('href', '/app/archiv')
    expect(screen.getByText('Open in archive')).toBeInTheDocument()
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
  })
})
