/**
 * API Schemas and Types
 *
 * Zod schemas for runtime validation of API responses.
 * All external data passes through these schemas at the adapter boundary.
 */

import { z } from 'zod'

// ============================================================================
// Chat Completion API (OpenAI-Compatible)
// ============================================================================

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  name: z.string().optional(),
})

export const ChatCompletionRequestSchema = z.object({
  messages: z.array(MessageSchema),
  model: z.string().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional(),
  session_id: z.string().optional(),
})

export const ChatCompletionChoiceSchema = z.object({
  index: z.number(),
  delta: z.object({
    role: z.enum(['assistant']).optional(),
    content: z.string().optional(),
  }),
  finish_reason: z.enum(['stop', 'length', 'tool_calls']).nullable(),
})

export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChatCompletionChoiceSchema),
})

// ============================================================================
// WebSocket Protocol (NAT Compatible)
// ============================================================================

/** NAT WebSocket message types */
export const NATMessageType = {
  USER_MESSAGE: 'user_message',
  SYSTEM_RESPONSE: 'system_response_message',
  SYSTEM_INTERMEDIATE: 'system_intermediate_message',
  SYSTEM_INTERACTION: 'system_interaction_message',
  USER_INTERACTION: 'user_interaction_message',
  OBSERVABILITY_TRACE: 'observability_trace_message',
  ERROR: 'error_message',
} as const

/** NAT workflow schema types */
export const NATSchemaType = {
  GENERATE: 'generate',
  GENERATE_STREAM: 'generate_stream',
  CHAT: 'chat',
  CHAT_STREAM: 'chat_stream',
} as const

/**
 * Human prompt input types from NAT.
 *
 * Aligned with NAT's real HITL enum: `text | notification | binary_choice |
 * radio | checkbox | dropdown | oauth_consent`. The legacy `multiple_choice`
 * and `approval` values are kept for back-compat with older backends and
 * persisted sessions. `radio`/`checkbox`/`dropdown` all map to the existing
 * choice rendering (OptionsList) — see `mapHumanPromptType`.
 */
export const HumanPromptType = {
  TEXT: 'text',
  NOTIFICATION: 'notification',
  BINARY_CHOICE: 'binary_choice',
  RADIO: 'radio',
  CHECKBOX: 'checkbox',
  DROPDOWN: 'dropdown',
  OAUTH_CONSENT: 'oauth_consent',
  // Legacy values (kept for back-compat, not part of NAT's current enum)
  MULTIPLE_CHOICE: 'multiple_choice',
  APPROVAL: 'approval',
} as const

/** Message status for WebSocket messages */
export const WebSocketMessageStatus = {
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const

// ----------------------------------------------------------------------------
// Outgoing Messages (Client -> Server)
// ----------------------------------------------------------------------------

/** Text content item for user messages (matches backend UserContent) */
export const NATUserContentTextSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

/** User message item (matches backend UserMessages) */
export const NATUserMessageItemSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.array(NATUserContentTextSchema),
})

/** User message content schema (matches backend UserMessageContent) */
export const NATUserMessageContentSchema = z.object({
  messages: z.array(NATUserMessageItemSchema),
})

/** NAT User Message - sent when user submits a chat message */
export const NATUserMessageSchema = z.object({
  type: z.literal(NATMessageType.USER_MESSAGE),
  schema_type: z.enum([
    NATSchemaType.GENERATE,
    NATSchemaType.GENERATE_STREAM,
    NATSchemaType.CHAT,
    NATSchemaType.CHAT_STREAM,
  ]),
  id: z.string().optional(),
  conversation_id: z.string().optional(),
  content: NATUserMessageContentSchema,
  timestamp: z.string().optional(),
  /** Optional list of enabled data source IDs to include in the query */
  enabled_data_sources: z.array(z.string()).optional(),
})

/** NAT User Interaction Response - sent when user responds to a prompt */
export const NATUserInteractionResponseSchema = z.object({
  type: z.literal(NATMessageType.USER_INTERACTION),
  id: z.string(),
  parent_id: z.string(),
  conversation_id: z.string().optional(),
  content: NATUserMessageContentSchema, // Same structure as user messages
  timestamp: z.string().optional(),
})

// ----------------------------------------------------------------------------
// Incoming Messages (Server -> Client)
// ----------------------------------------------------------------------------

/** Human prompt content - for clarification, approval, choices */
export const NATHumanPromptSchema = z.object({
  input_type: z.enum([
    HumanPromptType.TEXT,
    HumanPromptType.NOTIFICATION,
    HumanPromptType.BINARY_CHOICE,
    HumanPromptType.RADIO,
    HumanPromptType.CHECKBOX,
    HumanPromptType.DROPDOWN,
    HumanPromptType.OAUTH_CONSENT,
    // Legacy values still accepted for back-compat.
    HumanPromptType.MULTIPLE_CHOICE,
    HumanPromptType.APPROVAL,
  ]),
  text: z.string(),
  /**
   * Options for multiple choice prompts, normalised to the strings the UI sends back.
   *
   * NAT serialises a picker's choices as OBJECTS — `{id, label, value, description}`
   * on `HumanPromptRadio`/`Checkbox`/`Dropdown` — while older/simpler producers send
   * bare strings. Declaring only `z.array(z.string())` made the object form fail the
   * whole `NATIncomingMessageSchema` discriminated union, and `websocket-client`
   * `safeParse`s that: the entire `system_interaction` frame was dropped as an
   * unrecognised message, leaving the turn parked on its HITL future until the
   * 30-minute timeout. A silently discarded prompt is the worst failure this frame
   * has, because nothing surfaces — the answer simply never arrives.
   *
   * Normalised on `value`, not `label`: `value` is what the agent tier expects back
   * (NAT re-wraps the reply into `HumanResponse*.selected_option.value`), so if a
   * producer ever makes the two differ, the round-trip stays correct and only the
   * label shown degrades. That is the safe direction to fail in.
   */
  options: z
    .array(
      z.union([
        z.string(),
        z
          .object({
            id: z.string().optional(),
            label: z.string().optional(),
            value: z.string(),
            description: z.string().optional(),
          })
          .transform((option) => option.value),
      ])
    )
    .optional(),
  /** Default value for text input */
  default_value: z.string().optional(),
})

/** System Interaction Message - human prompt from agent */
export const NATSystemInteractionMessageSchema = z.object({
  type: z.literal(NATMessageType.SYSTEM_INTERACTION),
  id: z.string(),
  thread_id: z.string().optional(),
  parent_id: z.string(),
  conversation_id: z.string().optional(),
  content: NATHumanPromptSchema,
  status: z.enum([
    WebSocketMessageStatus.IN_PROGRESS,
    WebSocketMessageStatus.COMPLETE,
    WebSocketMessageStatus.ERROR,
  ]),
  timestamp: z.string().optional(),
})

/** System response content (SystemResponseContent format) */
export const NATSystemResponseContentSchema = z.object({
  role: z.literal('assistant').optional(),
  text: z.string().nullable().optional(),
})

/** Generate response content (GenerateResponse format - used by shallow/meta responses) */
export const NATGenerateResponseContentSchema = z.object({
  output: z.string(),
  value: z.string().optional(),
  intermediate_steps: z.array(z.unknown()).nullable().optional(),
})

/**
 * Wire cap for `answer_confidence_reason`, mirroring the backend's
 * `_CONFIDENCE_REASON_MAX_CHARS` (`shallow_researcher/markers.py`) and the
 * documented protocol limit (`docs/api/websocket-protocol.md`). A longer value
 * is a contract violation and degrades to "absent".
 */
export const ANSWER_CONFIDENCE_REASON_MAX_CHARS = 300

/** System Response Message - final or streaming response */
export const NATSystemResponseMessageSchema = z.object({
  type: z.literal(NATMessageType.SYSTEM_RESPONSE),
  id: z.string().optional(),
  thread_id: z.string().optional(),
  parent_id: z.string().optional(),
  conversation_id: z.string().optional(),
  // Content can be: string, SystemResponseContent (with text), or GenerateResponse (with output).
  // GenerateResponse must be tried FIRST: SystemResponseContent has only
  // optional fields and zod strips unknown keys, so it matches {output: ...}
  // too and would parse it to {} — silently discarding the response text.
  content: NATGenerateResponseContentSchema.or(NATSystemResponseContentSchema).or(z.string()),
  status: z.enum([
    WebSocketMessageStatus.IN_PROGRESS,
    WebSocketMessageStatus.COMPLETE,
    WebSocketMessageStatus.ERROR,
  ]),
  timestamp: z.string().optional(),
  cards: z.array(z.unknown()).optional(),
  // Structured deep-research job id (present when the turn dispatched an async
  // job). Preferred over regex-parsing the response prose.
  deep_research_job_id: z.string().optional(),
  // The model's guarded self-assessment of how well the answer is grounded in
  // its sources. Absent on error/escalation/marker-less turns → no chip. An
  // out-of-enum value degrades to `undefined` (no chip) via `.catch` rather than
  // failing the whole message parse and dropping the response text.
  answer_confidence: z.enum(['low', 'medium', 'high']).optional().catch(undefined),
  // Structured sources from the source registry (KB file/page/collection, RIS/web URLs).
  // Fail-open: PER-ENTRY tolerance — a single malformed source degrades to
  // undefined and is dropped, while the remaining (valid) citations survive.
  // The outer `.catch(undefined)` still guards against a non-array `sources`.
  sources: z
    .array(
      z
        .object({
          content: z.string().optional(),
          url: z.string().nullable().optional(),
          title: z.string().nullable().optional(),
          citation_key: z.string().nullable().optional(),
          collection: z.string().nullable().optional(),
          source_type: z.string().nullable().optional(),
          tool: z.string().nullable().optional(),
          origin: z.string().nullable().optional(),
          // The [N] citation label this source carries in the answer prose, so
          // the provenance block can render as the answer's numbered source
          // list instead of duplicating a written one.
          number: z.number().nullable().optional(),
          file_name: z.string().nullable().optional(),
          page: z.number().nullable().optional(),
        })
        .passthrough()
        // Per-entry tolerance: `.optional()` makes `undefined` a valid element
        // output so `.catch(undefined)` can degrade a single malformed source to
        // a hole (rather than needing a full object fallback), which the
        // transform below compacts out.
        .optional()
        .catch(undefined)
    )
    .optional()
    .catch(undefined)
    // Compact out the per-entry `.catch(undefined)` holes so consumers only see
    // the well-formed citations.
    .transform((arr) => (arr ? arr.filter((entry) => entry != null) : arr)),

  // ── Transparency extras (WP-A → WP-B wire contract) ──────────────────────
  // All optional + per-field `.catch(undefined)`: one malformed extra degrades
  // to "absent" and NEVER kills the whole frame (the response text survives).
  // These ride the same terminal-chunk "extras lift" as answer_confidence /
  // sources / deep_research_job_id.

  // Which path the turn took after intent classification.
  routing_decision: z.enum(['meta', 'shallow', 'deep', 'error']).optional().catch(undefined),
  // Human-readable "why" for the routing decision (verbatim from the classifier).
  routing_reason: z.string().optional().catch(undefined),
  // Present only when a shallow→deep escalation happened this turn.
  escalation_reason: z.string().optional().catch(undefined),
  // Present only when the self-reported confidence was downgraded. Five causes:
  //   'ungrounded'              — nothing verified and nothing measured.
  //   'quote_unverified'        — a quoted span did not match any source passage.
  //   'normative_claim_uncited' — the answer WAS grounded in an IFC measurement
  //                               but also asserts something normative with no
  //                               verified citation, so it is held at 'low'
  //                               instead of riding out on the measurement.
  //   'measurement_only'        — measured and purely descriptive, so 'high' was
  //                               reduced to 'medium'.
  //   'citation_fallback'       — the only citation came from the single-source
  //                               fallback, not from anything the model wrote,
  //                               so it lifts no further than a measurement.
  answer_confidence_capped_reason: z
    .enum([
      'ungrounded',
      'quote_unverified',
      'normative_claim_uncited',
      'measurement_only',
      'citation_fallback',
    ])
    .optional()
    .catch(undefined),
  // The model's own one-clause justification for its self-assessment
  // (`[CONFIDENCE:level | reason]`). Shown verbatim in the chip tooltip. Capped
  // at the documented wire limit — an oversized reason degrades to "absent",
  // never kills the frame.
  answer_confidence_reason: z
    .string()
    .max(ANSWER_CONFIDENCE_REASON_MAX_CHARS)
    .optional()
    .catch(undefined),
  // Present only when citation verification removed ≥1 citation.
  citations_removed: z
    .object({
      count: z.number(),
      reasons: z.array(z.string()),
    })
    .optional()
    .catch(undefined),
  // The skills the agent ACTIVATED this turn — i.e. the ones whose full
  // instructions it pulled into context with `use_skill`, in activation order.
  // Absent when the turn loaded none, which is the common case: a skill being
  // *available* costs a line of catalogue and is not reported.
  skills_activated: z.array(z.string()).optional().catch(undefined),
  // The subset of skills_activated marked grid-hidden — de-emphasised in the
  // disclosure, never dropped (the transparency doctrine).
  skills_hidden: z.array(z.string()).optional().catch(undefined),
  // Marks the answer text as a queue-rejection notice (NOT a research answer).
  job_admission_rejected: z.literal(true).optional().catch(undefined),
  // Retry hint (seconds) — only alongside job_admission_rejected.
  retry_after_seconds: z.number().optional().catch(undefined),
})

/** Intermediate step content */
export const NATIntermediateStepContentSchema = z.object({
  name: z.string(),
  payload: z.string(),
})

/** System Intermediate Message - thinking steps, tool calls */
export const NATSystemIntermediateMessageSchema = z.object({
  type: z.literal(NATMessageType.SYSTEM_INTERMEDIATE),
  id: z.string().optional(),
  thread_id: z.string().optional(),
  parent_id: z.string().optional(),
  conversation_id: z.string().optional(),
  content: NATIntermediateStepContentSchema.or(z.string()),
  status: z.enum([
    WebSocketMessageStatus.IN_PROGRESS,
    WebSocketMessageStatus.COMPLETE,
    WebSocketMessageStatus.ERROR,
  ]),
  timestamp: z.string().optional(),
})

/**
 * Observability Trace Message — diagnostic/tracing frame from NAT.
 *
 * The frontend does not render these; the variant exists so the frame is
 * TOLERATED (parsed + ignored) instead of tripping the discriminated-union
 * fallback and spamming `console.warn`. Payload is kept opaque (`z.unknown`)
 * and passthrough so a schema drift on the backend never fails the parse.
 */
export const NATObservabilityTraceMessageSchema = z
  .object({
    type: z.literal(NATMessageType.OBSERVABILITY_TRACE),
    id: z.string().optional(),
    thread_id: z.string().optional(),
    parent_id: z.string().optional(),
    conversation_id: z.string().optional(),
    content: z.unknown().optional(),
    status: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough()

/** Error content */
export const NATErrorContentSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.string().optional(),
})

/** Error Message */
export const NATErrorMessageSchema = z.object({
  type: z.literal(NATMessageType.ERROR),
  id: z.string().optional(),
  conversation_id: z.string().optional(),
  content: NATErrorContentSchema,
  status: z.literal(WebSocketMessageStatus.ERROR).optional(),
  timestamp: z.string().optional(),
})

/** Union of all incoming NAT WebSocket messages */
export const NATIncomingMessageSchema = z.discriminatedUnion('type', [
  NATSystemResponseMessageSchema,
  NATSystemIntermediateMessageSchema,
  NATSystemInteractionMessageSchema,
  NATObservabilityTraceMessageSchema,
  NATErrorMessageSchema,
])

// ----------------------------------------------------------------------------
// Legacy WebSocket Protocol (kept for backwards compatibility)
// ----------------------------------------------------------------------------

export const WebSocketConnectMessageSchema = z.object({
  type: z.literal('connect'),
  session_id: z.string(),
  /** Auth token for backend authentication */
  auth_token: z.string().optional(),
})

export const WebSocketUserMessageSchema = z.object({
  type: z.literal('message'),
  content: z.string(),
  session_id: z.string(),
})

export const WebSocketAgentTextMessageSchema = z.object({
  type: z.literal('agent_text'),
  content: z.string(),
  is_final: z.boolean(),
})

export const WebSocketStatusMessageSchema = z.object({
  type: z.literal('status'),
  status: z.enum(['thinking', 'processing', 'complete', 'error']),
  message: z.string().optional(),
})

export const WebSocketToolCallMessageSchema = z.object({
  type: z.literal('tool_call'),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()),
  tool_output: z.string().optional(),
})

export const WebSocketErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
})

export const WebSocketIncomingMessageSchema = z.discriminatedUnion('type', [
  WebSocketAgentTextMessageSchema,
  WebSocketStatusMessageSchema,
  WebSocketToolCallMessageSchema,
  WebSocketErrorMessageSchema,
])

// ============================================================================
// Workflow Configuration
// ============================================================================

export const WorkflowConfigSchema = z.object({
  Workflow: z.object({
    DisplayName: z.string(),
    Description: z.string(),
    Version: z.string(),
  }),
  Application: z.object({
    EnableConversationSideBar: z.boolean(),
    EnableFeedback: z.boolean(),
    EnableFileUpload: z.boolean(),
    MaxFileSize: z.number(),
    AllowedFileTypes: z.array(z.string()),
  }),
  Chat: z.object({
    SystemPrompt: z.string(),
    WelcomeMessage: z.string(),
    SuggestedQuestions: z.array(z.string()),
    MaxTokens: z.number(),
    Temperature: z.number(),
  }),
  Theme: z.object({
    PrimaryColor: z.string(),
    LogoUrl: z.string(),
    FaviconUrl: z.string(),
  }),
})

// ============================================================================
// Error Response
// ============================================================================

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
})

// ============================================================================
// Type Exports
// ============================================================================

export type Message = z.infer<typeof MessageSchema>
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>
export type ChatCompletionChoice = z.infer<typeof ChatCompletionChoiceSchema>

// NAT WebSocket Types
export type NATUserMessage = z.infer<typeof NATUserMessageSchema>
export type NATUserMessageContent = z.infer<typeof NATUserMessageContentSchema>
export type NATUserMessageItem = z.infer<typeof NATUserMessageItemSchema>
export type NATUserContentText = z.infer<typeof NATUserContentTextSchema>
export type NATUserInteractionResponse = z.infer<typeof NATUserInteractionResponseSchema>
export type NATHumanPrompt = z.infer<typeof NATHumanPromptSchema>
export type NATSystemInteractionMessage = z.infer<typeof NATSystemInteractionMessageSchema>
export type NATSystemResponseMessage = z.infer<typeof NATSystemResponseMessageSchema>
export type NATSystemResponseContent = z.infer<typeof NATSystemResponseContentSchema>
export type NATSystemIntermediateMessage = z.infer<typeof NATSystemIntermediateMessageSchema>
export type NATObservabilityTraceMessage = z.infer<typeof NATObservabilityTraceMessageSchema>
export type NATIntermediateStepContent = z.infer<typeof NATIntermediateStepContentSchema>
export type NATErrorMessage = z.infer<typeof NATErrorMessageSchema>
export type NATErrorContent = z.infer<typeof NATErrorContentSchema>
export type NATIncomingMessage = z.infer<typeof NATIncomingMessageSchema>

// Legacy WebSocket Types (kept for backwards compatibility)
export type WebSocketConnectMessage = z.infer<typeof WebSocketConnectMessageSchema>
export type WebSocketUserMessage = z.infer<typeof WebSocketUserMessageSchema>
export type WebSocketAgentTextMessage = z.infer<typeof WebSocketAgentTextMessageSchema>
export type WebSocketStatusMessage = z.infer<typeof WebSocketStatusMessageSchema>
export type WebSocketToolCallMessage = z.infer<typeof WebSocketToolCallMessageSchema>
export type WebSocketErrorMessage = z.infer<typeof WebSocketErrorMessageSchema>
export type WebSocketIncomingMessage = z.infer<typeof WebSocketIncomingMessageSchema>

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>
