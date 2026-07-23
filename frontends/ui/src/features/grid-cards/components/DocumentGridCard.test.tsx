/**
 * Render tests for the DocumentGridCard — the chat surfacing card that presents
 * REAL project/Büroarchiv files. Focus: surfaced file names resolve to their
 * live document rows (project + Archiv), the match snippet renders as the "why
 * it surfaced" evidence, and a file that no longer resolves degrades to a lean
 * "not available" card instead of vanishing or crashing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { DocumentGridCard } from './DocumentGridCard'
import { resetSurfacedDocumentsCache } from '@/features/documents/hooks/use-surfaced-documents'

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

afterEach(() => resetSurfacedDocumentsCache())

describe('DocumentGridCard', () => {
  it('resolves surfaced files to project + Archiv rows and shows the match snippet', async () => {
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [row('p1', 'Fluchtwegplan.pdf')] })),
      http.get('/api/archiv/documents', () =>
        HttpResponse.json({ documents: [row('a1', 'Referenzprojekt.pdf')], collectionName: 'archiv_o', canManage: false })
      ),
      // Thumbnails fail → deterministic SVG sketch fallback (no backend needed).
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 }))
    )

    render(
      <DocumentGridCard
        title="Relevante Dokumente – Fluchtwege"
        query="Fluchtwege"
        projectId="proj-1"
        documents={[
          { file_name: 'Fluchtwegplan.pdf', snippet: 'Der zweite Fluchtweg führt…', page: 2, score: 0.83, source: 'projekt' },
          { file_name: 'Referenzprojekt.pdf', snippet: 'Ähnlicher Grundriss…', page: null, score: 0.6, source: 'buero' },
        ]}
      />
    )

    expect(screen.getByText('Relevante Dokumente – Fluchtwege')).toBeInTheDocument()

    // Both surfaced files resolve to real file cards (name + summary/hint).
    await waitFor(() => expect(screen.getByText('Fluchtwegplan.pdf')).toBeInTheDocument())
    expect(screen.getByText('Referenzprojekt.pdf')).toBeInTheDocument()
    expect(screen.getByText('Der zweite Fluchtweg führt…')).toBeInTheDocument()
    // Provenance badges name each corpus.
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Office')).toBeInTheDocument()
  })

  it('degrades an unresolvable file to a "not available" card, never a crash', async () => {
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [] })),
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
    expect(screen.getByText('No longer available')).toBeInTheDocument()
  })

  it('renders nothing when there are no documents', () => {
    const { container } = render(<DocumentGridCard title="Leer" documents={[]} projectId="proj-1" />)
    expect(container).toBeEmptyDOMElement()
  })
})
