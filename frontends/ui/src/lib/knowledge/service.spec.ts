import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the workos-authkit import chain pulled in via backend-proxy.
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { UpstreamError } from '@/lib/api/errors'
import { getKnowledgeBaseStatus } from './service'

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
      removed: 0,
      inconsistent: 0,
      totalChunks: 42,
    })
    expect(status.files[0]).toEqual({
      fileName: 'oib-rl_1_ausgabe_mai_2023.pdf',
      state: 'ingested',
      sizeBytes: 1234,
      chunkCount: 42,
      ingestedSha256: 'abc',
      currentSha256: 'abc',
      ingestedAt: '2026-06-30T12:00:00Z',
      summary: 'Brandschutz.',
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
})
