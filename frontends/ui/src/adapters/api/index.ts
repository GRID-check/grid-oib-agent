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

// WebSocket Client (NAT Protocol)
export { NATWebSocketClient, createNATWebSocketClient } from './websocket-client'
export type {
  ConnectionStatus,
  NATWebSocketClientCallbacks,
  NATWebSocketClientOptions,
} from './websocket-client'
export { NATMessageType, NATSchemaType, HumanPromptType } from './websocket-client'
export type { NATHumanPrompt, NATIntermediateStepContent, NATErrorContent } from './websocket-client'

// Schemas and Types
export {
  MessageSchema,
  ChatCompletionChunkSchema,
  WorkflowConfigSchema,
  ApiErrorSchema,
  WebSocketIncomingMessageSchema,
} from './schemas'

export type {
  Message,
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionChoice,
  WebSocketConnectMessage,
  WebSocketUserMessage,
  WebSocketAgentTextMessage,
  WebSocketStatusMessage,
  WebSocketToolCallMessage,
  WebSocketErrorMessage,
  WebSocketIncomingMessage,
  WorkflowConfig,
  ApiError,
} from './schemas'

// Turn-event intermediate-step payloads (`status:<slot>` / `skill:<name>` / `skill_selection`)
export {
  StepEventPayloadSchema,
  StepEventChannelSchema,
  StepEventKindSchema,
  SkillPhaseSchema,
  parseStepEventPayloads,
  stepEventLiveText,
  unescapeStepPayload,
} from './step-event-schemas'
export type {
  StepEventPayload,
  StepEventChannel,
  StepEventKind,
  SkillPhase,
} from './step-event-schemas'

// Documents Client
export { createDocumentsClient } from './documents-client'
export type {
  DocumentsClient,
  DocumentsClientOptions,
  UploadFilesOptions,
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
