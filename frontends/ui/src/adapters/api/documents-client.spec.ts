/**
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDocumentsClient } from './documents-client'
import { installFakeXhr, type FakeXhrHandle } from '@/test-utils/xhr-mock'

// Mock the config - note: browser environment uses relative URLs
vi.mock('./config', () => ({
  apiConfig: {
    collectionsUrl: '/api/v1/collections',
    documentsBaseUrl: '/api/v1',
  },
}))

// Mock the schemas
vi.mock('./documents-schemas', () => ({
  CollectionInfoSchema: {
    parse: (data: unknown) => data,
  },
  FileInfoSchema: {
    parse: (data: unknown) => data,
  },
  FileListResponseSchema: {
    parse: (data: unknown) => data,
  },
  UploadResponseSchema: {
    parse: (data: unknown) => data,
  },
  IngestionJobStatusSchema: {
    parse: (data: unknown) => data,
  },
}))

describe('createDocumentsClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    global.fetch = mockFetch as typeof fetch
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('createCollection', () => {
    test('creates collection successfully', async () => {
      const mockCollection = { name: 'test-collection', description: 'Test' }

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCollection),
      })

      const client = createDocumentsClient()
      const result = await client.createCollection('test-collection', 'Test')

      expect(result).toEqual(mockCollection)
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-collection', description: 'Test' }),
      })
    })

    test('includes auth token when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test' }),
      })

      const client = createDocumentsClient({ authToken: 'test-token' })
      await client.createCollection('test')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
        })
      )
    })

    test('handles API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: { message: 'Invalid collection name' } }),
      })

      const client = createDocumentsClient()

      await expect(client.createCollection('test')).rejects.toThrow('Invalid collection name')
    })
  })

  describe('getCollection', () => {
    test('gets collection successfully', async () => {
      const mockCollection = { name: 'test-collection' }

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCollection),
      })

      const client = createDocumentsClient()
      const result = await client.getCollection('test-collection')

      expect(result).toEqual(mockCollection)
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/collections/test-collection',
        expect.any(Object)
      )
    })

    test('returns null for 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      })

      const client = createDocumentsClient()
      const result = await client.getCollection('nonexistent')

      expect(result).toBeNull()
    })

    test('passes abort signal', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test' }),
      })

      const controller = new AbortController()
      const client = createDocumentsClient()
      await client.getCollection('test', controller.signal)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: controller.signal,
        })
      )
    })
  })

  describe('deleteCollection', () => {
    test('deletes collection successfully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      })

      const client = createDocumentsClient()
      await client.deleteCollection('test-collection')

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/collections/test-collection',
        expect.objectContaining({
          method: 'DELETE',
        })
      )
    })

    test('ignores 404 on delete', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      })

      const client = createDocumentsClient()

      await expect(client.deleteCollection('nonexistent')).resolves.not.toThrow()
    })
  })

  // Uploads go over XHR, not fetch — it is the only transport that reports
  // request-upload progress, and the client no longer forks between the two.
  describe('uploadFiles', () => {
    let xhr: FakeXhrHandle

    beforeEach(() => {
      xhr = installFakeXhr()
    })

    afterEach(() => {
      xhr.restore()
    })

    test('uploads files successfully', async () => {
      const client = createDocumentsClient()
      const files = [
        new File(['content1'], 'file1.pdf', { type: 'application/pdf' }),
        new File(['content2'], 'file2.pdf', { type: 'application/pdf' }),
      ]

      const pending = client.uploadFiles('test-collection', files)
      xhr.last().respond(200, JSON.stringify({ job_id: 'job-123', file_ids: ['file-1', 'file-2'] }))

      await expect(pending).resolves.toEqual({ job_id: 'job-123', file_ids: ['file-1', 'file-2'] })
      expect(xhr.last().method).toBe('POST')
      expect(xhr.last().url).toBe('/api/v1/collections/test-collection/documents')
      expect(xhr.last().body).toBeInstanceOf(FormData)
    })

    test('lifts the API error message out of the response body', async () => {
      const client = createDocumentsClient()
      const files = [new File(['content'], 'file.pdf', { type: 'application/pdf' })]

      const pending = client.uploadFiles('test-collection', files)
      xhr.last().respond(400, JSON.stringify({ error: { message: 'File too large' } }))

      await expect(pending).rejects.toThrow('File too large')
    })

    test('reports upload progress', async () => {
      const client = createDocumentsClient()
      const files = [new File(['content'], 'file.pdf', { type: 'application/pdf' })]
      const onProgress = vi.fn()

      const pending = client.uploadFiles('test-collection', files, { onProgress })
      xhr.last().emitProgress(512, 2048)
      xhr.last().respond(200, JSON.stringify({ job_id: 'job-1', file_ids: ['file-1'] }))
      await pending

      expect(onProgress).toHaveBeenCalledWith(512, 2048)
    })

    test('aborts when the signal fires', async () => {
      const controller = new AbortController()
      const client = createDocumentsClient()
      const files = [new File(['content'], 'file.pdf', { type: 'application/pdf' })]

      const pending = client.uploadFiles('test-collection', files, { signal: controller.signal })
      controller.abort()

      await expect(pending).rejects.toThrow(/aborted/i)
      expect(xhr.last().aborted).toBe(true)
    })

    test('sends the auth token when one is configured', async () => {
      const client = createDocumentsClient({ authToken: 'token-abc' })
      const files = [new File(['content'], 'file.pdf', { type: 'application/pdf' })]

      const pending = client.uploadFiles('test-collection', files)
      xhr.last().respond(200, JSON.stringify({ job_id: 'job-1', file_ids: ['file-1'] }))
      await pending

      expect(xhr.last().headers['Authorization']).toBe('Bearer token-abc')
      // The browser must author the multipart Content-Type so it can append
      // the boundary — setting it by hand corrupts the body.
      expect(xhr.last().headers['Content-Type']).toBeUndefined()
    })
  })

  describe('listFiles', () => {
    test('lists files successfully with wrapped response', async () => {
      const mockFiles = {
        files: [
          { file_id: 'file-1', file_name: 'doc1.pdf' },
          { file_id: 'file-2', file_name: 'doc2.pdf' },
        ],
      }

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockFiles),
      })

      const client = createDocumentsClient()
      const result = await client.listFiles('test-collection')

      expect(result).toEqual(mockFiles.files)
    })

    test('lists files successfully with array response', async () => {
      const mockFiles = [
        { file_id: 'file-1', file_name: 'doc1.pdf' },
        { file_id: 'file-2', file_name: 'doc2.pdf' },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockFiles),
      })

      const client = createDocumentsClient()
      const result = await client.listFiles('test-collection')

      expect(result).toEqual(mockFiles)
    })
  })

  describe('deleteFiles', () => {
    test('deletes files successfully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      })

      const client = createDocumentsClient()
      await client.deleteFiles('test-collection', ['file-1', 'file-2'])

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/collections/test-collection/documents',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ file_ids: ['file-1', 'file-2'] }),
        })
      )
    })

    test('ignores 404 on delete', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      })

      const client = createDocumentsClient()

      await expect(client.deleteFiles('test', ['file-1'])).resolves.not.toThrow()
    })
  })

  describe('getJobStatus', () => {
    test('gets job status successfully', async () => {
      const mockStatus = {
        job_id: 'job-123',
        status: 'in_progress',
        file_details: [
          { file_id: 'file-1', file_name: 'doc.pdf', status: 'processing', progress_percent: 50 },
        ],
      }

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStatus),
      })

      const client = createDocumentsClient()
      const result = await client.getJobStatus('job-123')

      expect(result).toEqual(mockStatus)
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/documents/job-123/status',
        expect.any(Object)
      )
    })

    test('returns null for 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      })

      const client = createDocumentsClient()
      const result = await client.getJobStatus('nonexistent')

      expect(result).toBeNull()
    })

    test('passes abort signal', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ job_id: 'job-1', status: 'completed', file_details: [] }),
      })

      const controller = new AbortController()
      const client = createDocumentsClient()
      await client.getJobStatus('job-1', controller.signal)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: controller.signal,
        })
      )
    })

    test('handles API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      })

      const client = createDocumentsClient()

      await expect(client.getJobStatus('job-123')).rejects.toThrow(
        'Failed to get job status: Internal Server Error'
      )
    })
  })
})
