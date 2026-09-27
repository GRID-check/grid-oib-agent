/**
 * Documents API Client
 *
 * Collection reads, file listing / deletion and ingest-job polling for the
 * project and Archiv collections, through the `/api/v1` proxy. Uploads do not
 * go through here: every shelf posts to its first-party upload route, and a
 * chat's attachments are read and deleted through `session-documents-client`.
 */

import { apiConfig } from './config'
import {
  CollectionInfoSchema,
  FileInfoSchema,
  FileListResponseSchema,
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

// ============================================================================
// Types
// ============================================================================

export interface DocumentsClientOptions {
  /** Auth token for API requests */
  authToken?: string
}

// ============================================================================
// Helpers
// ============================================================================

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
 * const collection = await client.createCollection('proj_123')
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
     * Get a specific collection by name
     */
    async getCollection(name: string, signal?: AbortSignal): Promise<CollectionInfo | null> {
      const response = await fetch(`${getCollectionsUrl()}/${name}`, {
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
     * List files in a collection
     */
    async listFiles(collectionName: string, signal?: AbortSignal): Promise<FileInfo[]> {
      const response = await fetch(`${getCollectionsUrl()}/${collectionName}/documents`, {
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
      const response = await fetch(`${getCollectionsUrl()}/${collectionName}/documents`, {
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
