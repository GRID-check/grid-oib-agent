/**
 * Document API Schemas
 *
 * Zod schemas for runtime validation of document API responses.
 * All external data passes through these schemas at the adapter boundary.
 */

import { z } from 'zod'
import { verdictSchema } from '@/lib/upload-screening/quarantine'

/**
 * Why the content check held a file (ADR-0113): the backend's typed verdict,
 * parsed here by the one schema the BFF reads it with. One that does not parse
 * reads as none rather than failing the whole response; the file's legacy
 * `error_message` still says it was held (`reportsQuarantine`).
 */
const QuarantineFieldSchema = verdictSchema.nullable().catch(null).optional()

// ============================================================================
// Enums
// ============================================================================

/** File processing status */
export const DocumentFileStatusSchema = z.enum(['uploading', 'ingesting', 'success', 'failed'])

/**
 * A listed file's status: the backend's file vocabulary, plus the two states a
 * document can rest in that it has no word for. `stored`: the bytes are kept and
 * nothing read them. `held`: the content check stopped it (ADR-0086). The chat's
 * first-party listing says both (`sessionDocumentToFileInfo`), so a re-list
 * keeps them instead of turning a never-read attachment into an available one;
 * the proxy's listing never does. Neither is `success`, which is what counts
 * as an available source.
 */
export const ListedFileStatusSchema = z.enum([...DocumentFileStatusSchema.options, 'stored', 'held'])

/** Ingestion job state */
export const JobStateSchema = z.enum(['pending', 'processing', 'completed', 'failed'])

// ============================================================================
// Collection Schemas
// ============================================================================

/** Metadata about a collection/index */
export const CollectionInfoSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  file_count: z.number(),
  chunk_count: z.number(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  backend: z.string(),
  metadata: z.record(z.unknown()),
})

// ============================================================================
// File Schemas
// ============================================================================

/** Metadata about a file within a collection */
export const FileInfoSchema = z.object({
  file_id: z.string(),
  file_name: z.string(),
  collection_name: z.string(),
  status: ListedFileStatusSchema,
  file_size: z.number().nullable().optional(),
  chunk_count: z.number(),
  uploaded_at: z.string().nullable().optional(),
  ingested_at: z.string().nullable().optional(),
  expiration_date: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  quarantine: QuarantineFieldSchema,
  metadata: z.record(z.unknown()),
})

/** Response for list files endpoint */
export const FileListResponseSchema = z.object({
  files: z.array(FileInfoSchema),
})

/** Response for upload files endpoint */
export const UploadResponseSchema = z.object({
  job_id: z.string(),
  file_ids: z.array(z.string()),
  message: z.string().optional(),
})

// ============================================================================
// Job Status Schemas
// ============================================================================

/** Progress tracking for individual files within an ingestion job */
export const FileProgressSchema = z.object({
  file_id: z.string(),
  file_name: z.string(),
  status: DocumentFileStatusSchema,
  progress_percent: z.number(),
  error_message: z.string().nullable().optional(),
  quarantine: QuarantineFieldSchema,
  chunks_created: z.number().optional(),
})

/** Status model for async ingestion jobs */
export const IngestionJobStatusSchema = z.object({
  job_id: z.string(),
  status: JobStateSchema,
  submitted_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  total_files: z.number(),
  processed_files: z.number(),
  file_details: z.array(FileProgressSchema),
  collection_name: z.string(),
  backend: z.string(),
  error_message: z.string().nullable().optional(),
  metadata: z.record(z.unknown()),
})

// ============================================================================
// Type Exports
// ============================================================================

export type DocumentFileStatus = z.infer<typeof DocumentFileStatusSchema>
export type ListedFileStatus = z.infer<typeof ListedFileStatusSchema>
export type JobState = z.infer<typeof JobStateSchema>
export type CollectionInfo = z.infer<typeof CollectionInfoSchema>
export type FileInfo = z.infer<typeof FileInfoSchema>
export type FileListResponse = z.infer<typeof FileListResponseSchema>
export type UploadResponse = z.infer<typeof UploadResponseSchema>
export type FileProgress = z.infer<typeof FileProgressSchema>
export type IngestionJobStatus = z.infer<typeof IngestionJobStatusSchema>
