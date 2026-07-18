import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the workos-authkit import chain pulled in via backend-proxy.
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import {
  deleteKnowledgeBaseDocument,
  getKnowledgeBaseStatus,
  streamKnowledgeBaseDocument,
  syncKnowledgeBase,
  uploadKnowledgeBaseDocument,
} from './service'

const fetchMock = vi.fn()

const backendPayload = {
  collection_name: 'oib_knowledge',
  collection_exists: true,
  documents_dir: 'data/oib',
  collection_updated_at: '2026-07-01T00:00:00Z',
  summary: {
    total_files: 2,
    ingested: 1,
    stale: 0,
    pending: 1,
    removed: 0,
    inconsistent: 0,
    total_chunks: 42,
  },
  files: [
    {
      file_name: 'oib-rl_1_ausgabe_mai_2023.pdf',
      state: 'ingested',
      origin: 'corpus',
      size_bytes: 1234,
      chunk_count: 42,
      ingested_sha256: 'abc',
      current_sha256: 'abc',
      ingested_at: '2026-06-30T12:00:00Z',
      summary: 'Brandschutz.',
    },
    {
      file_name: 'new.pdf',
      state: 'pending',
      size_bytes: 99,
      chunk_count: 0,
      ingested_sha256: null,
      current_sha256: 'def',
      ingested_at: null,
      summary: null,
    },
  ],
}

describe('getKnowledgeBaseStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the backend snake_case payload to the UI camelCase shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(backendPayload), { status: 200 }))

    const status = await getKnowledgeBaseStatus()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/oib/status')
    expect(status.collectionName).toBe('oib_knowledge')
    expect(status.collectionExists).toBe(true)
    expect(status.summary).toEqual({
      totalFiles: 2,
      ingested: 1,
      stale: 0,
      pending: 1,
      snapshot: 0,
      removed: 0,
      inconsistent: 0,
      totalChunks: 42,
    })
    expect(status.files[0]).toEqual({
      fileName: 'oib-rl_1_ausgabe_mai_2023.pdf',
      state: 'ingested',
      origin: 'corpus',
      sizeBytes: 1234,
      chunkCount: 42,
      ingestedSha256: 'abc',
      currentSha256: 'abc',
      ingestedAt: '2026-06-30T12:00:00Z',
      summary: 'Brandschutz.',
      docClass: null,
    })
    expect(status.files[1].state).toBe('pending')
    expect(status.files[1].sizeBytes).toBe(99)
  })

  it('tolerates missing/malformed fields with safe defaults', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ files: [{ state: 'bogus', chunk_count: -3 }] }),
        { status: 200 },
      ),
    )

    const status = await getKnowledgeBaseStatus()

    expect(status.collectionName).toBe('')
    expect(status.collectionExists).toBe(false)
    expect(status.summary.totalFiles).toBe(0)
    expect(status.files[0]).toMatchObject({ fileName: 'unknown', state: 'pending', chunkCount: 0 })
  })

  it('throws UpstreamError on a non-OK backend response', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))

    await expect(getKnowledgeBaseStatus()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('throws UpstreamError when the backend is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(getKnowledgeBaseStatus()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('throws UpstreamError on malformed JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))

    await expect(getKnowledgeBaseStatus()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('maps snapshot state and file origin', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          collection_exists: true,
          summary: { snapshot: 1 },
          files: [{ file_name: 'a.pdf', state: 'snapshot', origin: 'index_only', chunk_count: 5 }],
        }),
        { status: 200 },
      ),
    )

    const status = await getKnowledgeBaseStatus()

    expect(status.summary.snapshot).toBe(1)
    expect(status.files[0]).toMatchObject({ state: 'snapshot', origin: 'index_only' })
  })
})

describe('knowledge admin operations', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.stubEnv('GRID_ADMIN_TOKEN', 'admin-secret')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('uploads a PDF with the admin token header', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', file_name: 'norm.pdf', message: 'ok' }), { status: 200 }),
    )

    const result = await uploadKnowledgeBaseDocument(new File([new Uint8Array([1])], 'norm.pdf'))

    expect(result).toMatchObject({ status: 'success', fileName: 'norm.pdf', message: 'ok' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/admin/oib/documents')
    expect((init?.headers as Record<string, string>)['X-Admin-Token']).toBe('admin-secret')
  })

  it('rejects non-PDF or path-carrying filenames before calling the backend', async () => {
    await expect(uploadKnowledgeBaseDocument(new File([new Uint8Array([1])], 'evil.exe'))).rejects.toBeInstanceOf(
      BadRequestError,
    )
    await expect(deleteKnowledgeBaseDocument('../secret.pdf')).rejects.toBeInstanceOf(BadRequestError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a 404 delete to NotFoundError', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))

    await expect(deleteKnowledgeBaseDocument('missing.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns sync counts', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ files_added: 3, files_total: 42, message: 'ok' }), { status: 200 }),
    )

    await expect(syncKnowledgeBase()).resolves.toEqual({ filesAdded: 3, filesTotal: 42, message: 'ok' })
  })

  it('streams a source PDF inline', async () => {
    const pdfBody = new Response(new Blob([new Uint8Array([37, 80, 68, 70])]), { status: 200 })
    fetchMock.mockResolvedValue(pdfBody)

    const res = await streamKnowledgeBaseDocument('oib-rl_1_ausgabe_mai_2023.pdf')

    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('inline')
  })

  it('maps a missing source PDF to NotFoundError', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))

    await expect(streamKnowledgeBaseDocument('gone.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })
})
