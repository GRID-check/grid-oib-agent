/**
 * Documents API Client
 *
 * Handles file upload, collection management, and ingestion status polling.
 * Works with both real backend and MSW mocks transparently.
 */

import { apiConfig } from './config'
import { xhrUpload, XhrUploadError } from '@/lib/http/xhr-upload'
import {
  CollectionInfoSchema,
  CollectionListResponseSchema,
  FileInfoSchema,
  FileListResponseSchema,
  UploadResponseSchema,
  IngestionJobStatusSchema,
  type CollectionInfo,
  type FileInfo,
  type IngestionJobStatus,
} from './documents-schemas'

const getCollectionsUrl = (): string => {
  const isBrowser = typeof window !== 'undefined'
  return isBrowser ? '/api/v1/collections' : apiConfig.collectionsUrl
}

const getDocumentsBaseUrl = (): string => {
  const isBrowser = typeof window !== 'undefined'
  return isBrowser ? '/api/v1' : apiConfig.documentsBaseUrl
}

const buildCollectionRequestUrl = (path: string, collectionName: string): string => {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  const url = new URL(path, baseUrl)

  if (collectionName.startsWith('s_')) {
    url.searchParams.set('conversationId', collectionName)
  }

  return path.startsWith('http://') || path.startsWith('https://')
    ? url.toString()
    : `${url.pathname}${url.search}`
}

// ============================================================================
// Types
// ============================================================================

export interface DocumentsClientOptions {
  /** Auth token for API requests */
  authToken?: string
}

export interface UploadFilesOptions {
  /** Progress callback for XHR upload */
  onProgress?: (loaded: number, total: number) => void
  /** AbortSignal for cancellation */
  signal?: AbortSignal
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Lift the API's own reason out of an error body, if it stated one.
 *
 * Two envelope shapes are in play — the BFF's `{ error: { message } }` and the
 * Python backend's flatter `{ error }` / `{ detail }` — and an upload refusal
 * ("file too large", "unsupported type") is exactly the message a user needs to
 * see, so it is worth reading all three rather than falling back to a status
 * code.
 */
function parseErrorMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as { error?: unknown; detail?: unknown }
    if (record.error && typeof record.error === 'object') {
      const message = (record.error as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    if (typeof record.error === 'string' && record.error) return record.error
    if (typeof record.detail === 'string' && record.detail) return record.detail
    return null
  } catch {
    return null
  }
}

/**
 * Parse API error response and throw a consistent error
 */
async function handleApiError(response: Response, context: string): Promise<never> {
  const error = await response.json().catch(() => ({}))
  throw new Error(error?.error?.message || `${context}: ${response.statusText}`)
}

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Create a documents API client
 *
 * @param options - Client options including auth token
 * @returns Documents client with all API methods
 *
 * @example
 * ```typescript
 * const { idToken } = useAuth()
 * const client = createDocumentsClient({ authToken: idToken })
 *
 * // Create collection
 * const collection = await client.createCollection('my-session-id')
 *
 * // Upload files
 * const { job_id, file_ids } = await client.uploadFiles('my-session-id', files)
 *
 * // Poll for status
 * const status = await client.getJobStatus(job_id)
 * ```
 */
export const createDocumentsClient = (options: DocumentsClientOptions = {}) => {
  const { authToken } = options

  // Helper to create headers
  const getHeaders = (includeContentType = true): Record<string, string> => {
    const headers: Record<string, string> = {}
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`
    }
    if (includeContentType) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  return {
    // --------------------------------------------------------------------------
    // Collection Management
    // --------------------------------------------------------------------------

    /**
     * Create a new collection
     */
    async createCollection(name: string, description?: string): Promise<CollectionInfo> {
      const response = await fetch(getCollectionsUrl(), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name, description }),
      })

      if (!response.ok) {
        await handleApiError(response, 'Failed to create collection')
      }

      const data = await response.json()
      return CollectionInfoSchema.parse(data)
    },

    /**
     * List all collections
     */
    async listCollections(): Promise<CollectionInfo[]> {
      const response = await fetch(getCollectionsUrl(), {
        method: 'GET',
        headers: getHeaders(),
      })

      if (!response.ok) {
        await handleApiError(response, 'Failed to list collections')
      }

      const data = await response.json()
      const validated = CollectionListResponseSchema.parse(data)
      return validated.collections
    },

    /**
     * Get a specific collection by name
     */
    async getCollection(name: string, signal?: AbortSignal): Promise<CollectionInfo | null> {
      const response = await fetch(buildCollectionRequestUrl(`${getCollectionsUrl()}/${name}`, name), {
        method: 'GET',
        headers: getHeaders(),
        signal,
      })

      if (response.status === 404) {
        return null
      }

      if (!response.ok) {
        await handleApiError(response, 'Failed to get collection')
      }

      const data = await response.json()
      return CollectionInfoSchema.parse(data)
    },

    /**
     * Delete a collection and all its files
     */
    async deleteCollection(name: string): Promise<void> {
      const response = await fetch(`${getCollectionsUrl()}/${name}`, {
        method: 'DELETE',
        headers: getHeaders(),
      })

      if (!response.ok && response.status !== 404) {
        await handleApiError(response, 'Failed to delete collection')
      }
    },

    // --------------------------------------------------------------------------
    // File Operations
    // --------------------------------------------------------------------------

    /**
     * Upload files to a collection
     *
     * @param collectionName - Target collection name
     * @param files - Files to upload
     * @param options - Upload options (progress callback)
     * @returns Job ID and file IDs for status polling
     */
    async uploadFiles(
      collectionName: string,
      files: File[],
      options?: UploadFilesOptions
    ): Promise<{ job_id: string; file_ids: string[] }> {
      const formData = new FormData()
      files.forEach((file) => {
        formData.append('files', file)
      })

      const headers: Record<string, string> = {}
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`
      }
      // Content-Type is deliberately unset: the browser authors it for FormData
      // so it can append the multipart boundary.

      // One transport for every caller, progress callback or not. This used to
      // fork — XHR when a caller wanted progress, `fetch` otherwise — and the
      // two branches had drifted into different error messages and different
      // abort behaviour, on the path where an upload most needs to say clearly
      // what went wrong. `fetch` cannot report upload progress at all, so the
      // shared helper is XHR (see `lib/http/xhr-upload`).
      let responseText: string
      try {
        responseText = await xhrUpload({
          url: buildCollectionRequestUrl(`${getCollectionsUrl()}/${collectionName}/documents`, collectionName),
          body: formData,
          headers,
          onProgress: options?.onProgress,
          signal: options?.signal,
        })
      } catch (error) {
        if (error instanceof XhrUploadError) {
          throw new Error(parseErrorMessage(error.responseText) || `Failed to upload files: ${error.status}`)
        }
        throw error
      }

      const validated = UploadResponseSchema.parse(JSON.parse(responseText))
      return {
        job_id: validated.job_id,
        file_ids: validated.file_ids,
      }
    },

    /**
     * List files in a collection
     */
    async listFiles(collectionName: string, signal?: AbortSignal): Promise<FileInfo[]> {
      const response = await fetch(buildCollectionRequestUrl(`${getCollectionsUrl()}/${collectionName}/documents`, collectionName), {
        method: 'GET',
        headers: getHeaders(),
        signal,
      })

      if (!response.ok) {
        await handleApiError(response, 'Failed to list files')
      }

      const data = await response.json()

      // API might return array directly OR wrapped in {files: [...]}
      // Handle both cases
      if (Array.isArray(data)) {
        // Validate each file individually
        return data.map((file) => FileInfoSchema.parse(file))
      }

      const validated = FileListResponseSchema.parse(data)
      return validated.files
    },

    /**
     * Delete files from a collection
     */
    async deleteFiles(collectionName: string, fileIds: string[]): Promise<void> {
      const response = await fetch(buildCollectionRequestUrl(`${getCollectionsUrl()}/${collectionName}/documents`, collectionName), {
        method: 'DELETE',
        headers: getHeaders(),
        body: JSON.stringify({ file_ids: fileIds }),
      })

      if (!response.ok && response.status !== 404) {
        await handleApiError(response, 'Failed to delete files')
      }
    },

    // --------------------------------------------------------------------------
    // Job Status (Polling)
    // --------------------------------------------------------------------------

    /**
     * Get ingestion job status
     *
     * @param jobId - Job ID from uploadFiles response
     * @param signal - Optional AbortSignal for cancellation
     * @returns Job status with file progress details
     */
    async getJobStatus(jobId: string, signal?: AbortSignal): Promise<IngestionJobStatus | null> {
      const response = await fetch(`${getDocumentsBaseUrl()}/documents/${jobId}/status`, {
        method: 'GET',
        headers: getHeaders(),
        signal,
      })

      if (response.status === 404) {
        return null
      }

      if (!response.ok) {
        await handleApiError(response, 'Failed to get job status')
      }

      const data = await response.json()
      return IngestionJobStatusSchema.parse(data)
    },
  }
}

export type DocumentsClient = ReturnType<typeof createDocumentsClient>
