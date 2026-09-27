/**
 * API Adapters
 *
 * Re-exports all API-related functionality for use in features.
 * Features should import from '@/adapters/api' only.
 */

// Configuration
export { apiConfig, getWebSocketUrl } from './config'

// Shared API error carrying the HTTP status for structural classification
export { ApiRequestError } from './api-error'

// The chat socket, wire v2 (`docs/design/chat-wire-v2.md`)
export { createTurnSocket } from './turn-socket'
export type { OpenTurn, TurnSocket, TurnSocketOptions, TurnSocketStatus } from './turn-socket'

// Documents Client
export { createDocumentsClient } from './documents-client'
export type {
  DocumentsClient,
  DocumentsClientOptions,
} from './documents-client'

// Data Sources Client
export { createDataSourcesClient } from './data-sources-client'
export type {
  DataSourcesClient,
  DataSourcesClientOptions,
  DataSourceFromAPI,
  DataSourcesResponse,
} from './data-sources-client'

// Documents Schemas
export {
  DocumentFileStatusSchema,
  JobStateSchema,
  CollectionInfoSchema,
  FileInfoSchema,
  FileProgressSchema,
  IngestionJobStatusSchema,
} from './documents-schemas'

export type {
  DocumentFileStatus,
  JobState,
  CollectionInfo,
  FileInfo,
  FileProgress,
  IngestionJobStatus,
} from './documents-schemas'

// Conversations Client (BFF CRUD)
export { conversationsClient } from './conversations-client'
export type { ConversationsClient, ConversationSummary } from './conversations-client'

// Deep Research Client (SSE Streaming for async jobs)
export { createDeepResearchClient, getJobStatus, getJobState, getJobReport, cancelJob } from './deep-research-client'
export type { JobReportFiling, JobReportResponse } from './deep-research-client'
export type {
  DeepResearchJobStatus,
  DeepResearchEventType,
  ArtifactType,
  DeepResearchSSEEvent,
  StreamStartEvent,
  JobStatusEvent,
  WorkflowStartEvent,
  WorkflowEndEvent,
  LLMStartEvent,
  LLMChunkEvent,
  LLMEndEvent,
  ToolStartEvent,
  ToolEndEvent,
  TodoItem,
  ArtifactUpdateEvent,
  DeepResearchEvent,
  DeepResearchCallbacks,
  DeepResearchStreamOptions,
  DeepResearchClient,
  JobStateResponse,
} from './deep-research-client'
