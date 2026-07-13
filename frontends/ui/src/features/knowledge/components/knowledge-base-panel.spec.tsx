import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { KnowledgeBasePanel } from './knowledge-base-panel'

const corpusStatus = {
  collectionName: 'oib_knowledge',
  collectionExists: true,
  collectionUpdatedAt: '2026-07-01T00:00:00Z',
  summary: {
    totalFiles: 3,
    ingested: 1,
    stale: 1,
    pending: 1,
    snapshot: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: 128,
  },
  files: [
    {
      fileName: 'oib-rl_1_ausgabe_mai_2023.pdf',
      state: 'ingested',
      origin: 'corpus',
      sizeBytes: 2048,
      chunkCount: 64,
      ingestedSha256: 'abc',
      currentSha256: 'abc',
      ingestedAt: '2026-06-30T12:00:00Z',
      summary: 'Fire safety guideline.',
    },
    {
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      state: 'stale',
      origin: 'corpus',
      sizeBytes: 4096,
      chunkCount: 64,
      ingestedSha256: 'old',
      currentSha256: 'new',
      ingestedAt: '2026-06-30T12:00:00Z',
      summary: null,
    },
    {
      fileName: 'oib-rl_3_ausgabe_mai_2023.pdf',
      state: 'pending',
      origin: 'corpus',
      sizeBytes: 1024,
      chunkCount: 0,
      ingestedSha256: null,
      currentSha256: 'fresh',
      ingestedAt: null,
      summary: null,
    },
  ],
}

function mockEndpoints({
  corpus = corpusStatus,
  documents = [],
  corpusStatusCode = 200,
}: {
  corpus?: Record<string, unknown>
  documents?: Record<string, unknown>[]
  corpusStatusCode?: number
} = {}) {
  server.use(
    http.get('/api/knowledge-base', () =>
      corpusStatusCode === 200
        ? HttpResponse.json(corpus)
        : new HttpResponse(null, { status: corpusStatusCode }),
    ),
    http.get('/api/documents', () => HttpResponse.json({ documents })),
  )
}

describe('KnowledgeBasePanel', () => {
  it('lists every corpus file with its index state', async () => {
    mockEndpoints()
    render(<KnowledgeBasePanel projectId="proj-1" />)

    expect(await screen.findByText('oib-rl_1_ausgabe_mai_2023.pdf')).toBeDefined()
    expect(screen.getByText('oib-rl_2_ausgabe_mai_2023.pdf')).toBeDefined()
    expect(screen.getByText('oib-rl_3_ausgabe_mai_2023.pdf')).toBeDefined()
    // "Indexed" appears both as a summary-tile label and a status badge.
    expect(screen.getAllByText('Indexed').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Outdated')).toBeDefined()
    expect(screen.getByText('Not indexed yet')).toBeDefined()
    // Generated document summary is surfaced as the subline.
    expect(screen.getByText('Fire safety guideline.')).toBeDefined()
  })

  it('shows summary counts including the needs-attention total', async () => {
    mockEndpoints()
    render(<KnowledgeBasePanel projectId="proj-1" />)

    await screen.findByText('oib-rl_1_ausgabe_mai_2023.pdf')
    // 128 searchable chunks and 2 files needing attention (1 stale + 1 pending).
    expect(screen.getByText('128')).toBeDefined()
    expect(screen.getByText('Searchable chunks')).toBeDefined()
    expect(screen.getByText('Needs attention')).toBeDefined()
  })

  it('lists project documents alongside the corpus', async () => {
    mockEndpoints({
      documents: [
        {
          id: 'doc-1',
          filename: 'statik-gutachten.pdf',
          fileSize: 500,
          contentType: 'application/pdf',
          status: 'ready',
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
    })
    render(<KnowledgeBasePanel projectId="proj-1" />)

    expect(await screen.findByText('statik-gutachten.pdf')).toBeDefined()
  })

  it('shows the empty invitation when the project has no documents', async () => {
    mockEndpoints({ documents: [] })
    render(<KnowledgeBasePanel projectId="proj-1" />)

    await screen.findByText('oib-rl_1_ausgabe_mai_2023.pdf')
    expect(screen.getByText(/No project documents yet/)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Manage files' })).toBeDefined()
  })

  it('surfaces a retryable error when the knowledge base cannot be loaded', async () => {
    mockEndpoints({ corpusStatusCode: 503 })
    render(<KnowledgeBasePanel projectId="proj-1" />)

    expect(await screen.findByText('Knowledge base unavailable')).toBeDefined()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeDefined()
  })

  it('explains when the index has not been built yet', async () => {
    mockEndpoints({
      corpus: {
        ...corpusStatus,
        collectionExists: false,
        files: [],
        summary: { ...corpusStatus.summary, totalFiles: 0, ingested: 0, totalChunks: 0, stale: 0, pending: 0 },
      },
    })
    render(<KnowledgeBasePanel projectId="proj-1" />)

    await waitFor(() => {
      expect(screen.getByText(/has not been built yet/)).toBeDefined()
    })
  })
})
