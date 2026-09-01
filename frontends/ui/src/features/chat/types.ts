/**
 * Chat Feature Types
 *
 * Type definitions for chat messages, conversations, and state.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { CardDecision, CardInteractions } from '@/features/grid-cards/card-decision'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'
import type { MessageStages } from '@/lib/conversations/message-stages'
import type { StageFrame } from './stores/messages-store'
import type { SourceSignal } from '@/features/layout/lib/source-presets'

import type { Shelf, SourceKind } from './lib/source-kinds'

/** Message role types */
export type MessageRole = 'user' | 'assistant' | 'system'

/** Message types for different display purposes */
export type MessageType =
  | 'user'
  | 'assistant'
  | 'status'
  | 'prompt'
  | 'agent_response'
  | 'file'
  | 'error'
  | 'deep_research_banner'

/** Deep research banner types for status notifications */
export type DeepResearchBannerType = 'starting' | 'success' | 'failure' | 'cancelled' | 'expired'

/** File upload status types for banner messages */
export type FileUploadStatusType = 'uploaded' | 'pending_warning'

/** What this Ask Piloti turn is about — the same composer, not a second chat. */
export interface ComposerSubject {
  resourceType: 'document'
  resourceId: string
  title?: string | null
  /** Stored file name — retrieval identity, not the label. */
  filename?: string | null
  /**
   * Which knowledge shelf the file sits on. Sent as ``focus_shelf``; the
   * agent maps it to the shelves it may keep. "Summarize this upload"
   * does not walk the Archiv (#429); a project file does not mix in
   * Büro hits (#436).
   */
  shelf?: 'project' | 'archiv' | 'session'
}

/** A queued composer prefill: the text plus any structured mentions it renders. */
export interface ComposerPrefill {
  text: string
  mentions?: DraftMention[]
  /**
   * Optional subject of this ask (a project file). IFC walls, applicable
   * standards and Files all land here — one pipe.
   */
  subject?: ComposerSubject
}

/** Status types for status card messages */
export type StatusType =
  | 'thinking'
  | 'searching'
  | 'planning'
  | 'researching'
  | 'writing'
  | 'complete'
  | 'data_source_added'
  | 'data_source_removed'
  | 'error'

/** File status for file operations */
export type FileStatus = 'uploading' | 'ingesting' | 'success' | 'deleted' | 'error'

/** Error codes using dot-notation for extensibility */
export type ErrorCode =
  // Connection errors
  | 'connection.lost'
  | 'connection.failed'
  | 'connection.timeout'
  // Auth errors
  | 'auth.session_expired'
  | 'auth.unauthorized'
  // Agent errors
  | 'agent.response_failed'
  | 'agent.response_interrupted'
  | 'agent.workflow_error'
  | 'agent.deep_research_failed'
  | 'agent.deep_research_load_failed'
  // Research errors
  // Deep-research job could not be admitted (queue full). Warning-styled, and
  // NON-locking: the composer stays usable so the user can retry.
  | 'research.queue_full'
  // Budget errors
  | 'budget.exhausted'
  // System errors
  | 'system.unknown'

/** Prompt types for agent prompts requiring user response */
export type PromptType = 'clarification' | 'approval' | 'choice' | 'text-input' | 'plan_approval'

/**
 * Human prompt input types, aligned with NAT's real HITL enum plus the legacy
 * values kept for back-compat. `radio`/`checkbox`/`dropdown` render with the
 * existing choice UI; see `mapHumanPromptType`.
 */
export type HumanPromptInputType =
  | 'text'
  | 'notification'
  | 'binary_choice'
  | 'radio'
  | 'checkbox'
  | 'dropdown'
  | 'oauth_consent'
  // Legacy values (older backends / persisted sessions)
  | 'multiple_choice'
  | 'approval'

/**
 * Transparency extras attached to an answer from the terminal system_response
 * frame (WP-A → WP-B wire contract). All optional; each renders its own bit of
 * UI (routing narration, capped-confidence note, citations-removed note) only
 * when present.
 */
export interface AnswerTransparency {
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  routingReason?: string
  escalationReason?: string
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  /** The model's own one-clause justification for its self-assessment, shown verbatim in the chip tooltip. */
  answerConfidenceReason?: string
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * The turn's research was CUT OFF at its tool-iteration ceiling: the answer
   * rests on the evidence gathered up to that point, not on a finished search.
   * Present or absent, never false. Independent of `answerConfidence` — a
   * truncated answer can be perfectly grounded in the little it did find.
   */
  researchTruncated?: true
  /**
   * WHY the research stopped early, as a stable token the dictionary turns into
   * words. Read independently of `researchTruncated`: the flag and its cause
   * are separate facts on the wire, and a cause without a flag says nothing.
   */
  truncationReason?: string
  /**
   * Ways this answer came out weaker than a healthy run, as stable tokens.
   * Absent rather than empty — an empty list is not a claim.
   */
  degradedReasons?: string[]
  /**
   * Skills whose full instructions the agent loaded this turn (`use_skill`), in
   * activation order. Absent when none — a skill merely being available is not
   * reportable, only the decision to load one is.
   */
  skillsActivated?: string[]
  /** The grid-hidden subset of skillsActivated — muted in the disclosure, never dropped. */
  skillsHidden?: string[]
}

/** File card data for file messages */
export interface FileCardData {
  fileName: string
  fileSize?: number
  fileStatus: FileStatus
  progress?: number
  errorMessage?: string
}

/** Error card data for error messages */
export interface ErrorCardData {
  errorCode: ErrorCode
  errorMessage?: string
  errorDetails?: string
}

/** File upload status data for banner messages */
export interface FileUploadStatusData {
  /** Type of status: uploaded (files uploaded, ingesting) or ingested (ready to use) */
  type: FileUploadStatusType
  /** Number of files in the batch */
  fileCount: number
  /** Job ID to prevent duplicate banners */
  jobId: string
}

/** Deep research banner data for status notifications */
export interface DeepResearchBannerData {
  /** Type of banner: starting, success, failure, cancellation, or expiry */
  bannerType: DeepResearchBannerType
  /** Job ID for identification */
  jobId: string
  /**
   * Total tokens the run consumed, as the stream reported it.
   *
   * Recorded, not rendered: the success banner used to print it as „Textmenge",
   * a number with no reader-facing unit, and that statistic was removed rather
   * than reworded. The field stays because turns already stored carry it and
   * because it is the honest place to put the figure if a surface for our own
   * cost ever earns one; nothing in the UI reads it today.
   */
  totalTokens?: number
  /** Number of tool calls (for success banner) */
  toolCallCount?: number
  /**
   * Narration shown above a `starting` banner when the turn escalated
   * shallow→deep — `Eskaliert zur Tiefenrecherche: <reason>` per the contract.
   */
  escalationReason?: string
  /**
   * The document this run's report was filed as, once the BFF has reported one.
   *
   * Absent is the NORMAL, honest state, not a loading state: filing is skipped
   * when the chat has no project, and for every run that finished before this
   * feature existed. The banner therefore says nothing at all when this is
   * missing — it must never offer to open a file that does not exist, and
   * "maybe there is a document" is not a thing to render.
   */
  filedDocument?: DeepResearchFiledDocument
  /**
   * A filing this run's starting banner PROMISED, which then did not land.
   *
   * The one state `filedDocument` being absent used to swallow. Absence still
   * means "nothing was ever promised" — no project, no attempt, an older run —
   * and stays silent. This flag means the opposite: the disclosure
   * („Der fertige Bericht wird in diesem Projekt unter ‚Berichte' abgelegt.")
   * was shown, the run finished, and there is no file. That reader is going to
   * go and look; the banner owes them the correction, in the same quiet
   * register the promise was made in.
   *
   * Set from the report route's `filingFailed`, which is raised only when a
   * project was resolved — the same condition under which the disclosure
   * rendered. It carries no reason, deliberately: see `JobReportResponse`.
   */
  filingFailed?: boolean
}

/**
 * A filed agent-authored report, as the report route reports it back.
 *
 * `alreadyFiled` is deliberately NOT carried here. It answers "did this call
 * create the row", which is a question about the request, not about the
 * document — the banner shows the same link whether the row was created by this
 * fetch or by the one before it.
 */
export interface DeepResearchFiledDocument {
  /** `documents.id` — what the `/files?doc=` deep link addresses. */
  documentId: string
  /** The generated filename, so the banner can name what now exists. */
  filename: string
}

/** Individual chat message */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: Date
  /** Type of message for routing to correct display */
  messageType?: MessageType
  /** Whether this message is still streaming */
  isStreaming?: boolean
  /** Intermediate thinking steps from the agent */
  intermediateSteps?: IntermediateStep[]
  /** Status type for status messages */
  statusType?: StatusType
  /** Prompt type for prompt messages */
  promptType?: PromptType
  /** Prompt ID for HITL routing (may differ from message ID) */
  promptId?: string
  /** Parent message ID for HITL response routing */
  promptParentId?: string
  /** Input type for HITL prompts */
  promptInputType?: HumanPromptInputType
  /** Options for choice prompts */
  promptOptions?: string[]
  /** Placeholder for text input prompts */
  promptPlaceholder?: string
  /** User's response to prompt */
  promptResponse?: string
  /** Whether the prompt has been responded to */
  isPromptResponded?: boolean
  /**
   * The person the agent asked (ADR-0037). Present on a prompt restored from the
   * server; absent on a live one, where the browser holding the socket IS the
   * addressee by construction.
   *
   * Every other reader is shown the question read-only, because the agent tier
   * refuses an answer from anybody but this person — offering them buttons would be
   * offering a refusal.
   */
  promptFor?: string
  /** File card data for file messages */
  fileData?: FileCardData
  /** Error card data for error messages */
  errorData?: ErrorCardData
  /** File upload status data for banner messages */
  fileUploadStatusData?: FileUploadStatusData
  /** Deep research banner data for status notifications */
  deepResearchBannerData?: DeepResearchBannerData
  /** Whether to show "View Report" button on agent responses */
  showViewReport?: boolean

  // Session persistence fields (embedded in messages for localStorage persistence)

  /** Thinking steps that occurred during processing (for user messages) */
  thinkingSteps?: ThinkingStep[]
  /** Report content shown in ResearchPanel (for agent_response messages) */
  reportContent?: string
  /** Citations/sources used (for agent_response messages) */
  citations?: CitationSource[]

  // ResearchPanel persistence fields (for agent_response messages)

  /** Plan messages shown in chat/HITL restore flows */
  planMessages?: PlanMessage[]
  /** Task todos shown in TasksTab */
  deepResearchTodos?: DeepResearchTodo[]
  /** LLM steps shown in ThoughtTracesTab */
  deepResearchLLMSteps?: DeepResearchLLMStep[]
  /** Agent steps shown in AgentsTab */
  deepResearchAgents?: DeepResearchAgent[]
  /** Tool calls shown in ToolCallsTab */
  deepResearchToolCalls?: DeepResearchToolCall[]
  /** File artifacts shown in FilesTab */
  deepResearchFiles?: DeepResearchFile[]

  // Deep research job persistence fields (for session restoration across tab close/reopen)

  /** Deep research job ID for session restoration */
  deepResearchJobId?: string
  /** Last SSE event ID received (for reconnection to running jobs) */
  deepResearchLastEventId?: string
  /** Job status at time of save (submitted, running, success, failure, interrupted) */
  deepResearchJobStatus?: DeepResearchJobStatus
  /** True when a completed report's backend job/report can no longer be loaded. */
  deepResearchReportExpired?: boolean
  /** Whether this message has active (streaming) deep research - used for UI state */
  isDeepResearchActive?: boolean
  /** Data sources that were enabled when this message was sent (for display in thinking panel) */
  enabledDataSources?: string[]
  /** Files that were available when this message was sent (for display in thinking panel) */
  messageFiles?: Array<{ id: string; fileName: string }>
  /** Grid cards rendered with this agent response */
  cards?: GridCard[]
  /**
   * The user's answer to each interactive card of this answer (`accepted`,
   * `dismissed`, …), keyed by `cardKey(card, index)`. Persisted alongside
   * `cards` in both storage layers so an applied patch / saved memory stays
   * settled across reloads instead of re-offering buttons that would apply it
   * twice — the card-level twin of `isPromptResponded` (see
   * `features/grid-cards/card-decision.ts`).
   */
  cardInteractions?: CardInteractions
  /**
   * WHICH person wrote this message (collaboration, ADR-0032/CC-3).
   *
   * `role` only ever said what KIND of author wrote a message, which was free
   * while a thread had one human in it. With two it is a defect: the reader must
   * be able to tell colleagues apart, and apart from the agent. Absent/null for
   * assistant, status and system messages, and for solo threads where the UI
   * deliberately renders no attribution at all.
   */
  authorUserId?: string | null
  /** Resolved display name + avatar, so a bubble needs no directory lookup. */
  authorName?: string | null
  authorAvatarUrl?: string | null
  /**
   * Structured mentions carried by this message, in the order they appear.
   * Deliberately NOT derived from the text: typing the characters "@Anna"
   * without choosing her from the picker is not a mention and must not notify
   * her (spec MN-3).
   */
  mentions?: Array<{ targetId: string; display: string }>
  /**
   * Who the message was addressed to, as ruled by the SERVER at persist time
   * (spec MN-1/MN-2). The client stores it for rendering only — the decision of
   * whether to open an agent turn was already made from this value.
   */
  addressees?: { agent: boolean; users: string[] }
  /**
   * The assistant's own guarded self-assessment of how well this answer is
   * grounded in its sources (shallow answers only). Absent on error, escalation,
   * deep-research, and historical turns — nothing renders when undefined.
   */
  answerConfidence?: 'low' | 'medium' | 'high'
  /**
   * Why the self-assessed confidence was capped (WP-A transparency extra),
   * surfaced as an extra sentence in the ConfidenceChip tooltip (PB-9). See
   * {@link AnswerConfidenceCappedReason} for the causes it can carry.
   */
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  /**
   * The model's own one-clause justification for its confidence level
   * (`[CONFIDENCE:level | reason]`). Shown verbatim in the ConfidenceChip
   * tooltip so the reader can see WHY the level was chosen.
   */
  answerConfidenceReason?: string
  /**
   * Which path the turn took after intent classification (meta/shallow/deep/
   * error) — drives the "Warum dieser Weg?" narration in the Herleitung.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Human-readable "why" for the routing decision (verbatim from classifier). */
  routingReason?: string
  /** Narration shown when the turn escalated shallow→deep this turn. */
  escalationReason?: string
  /**
   * Citation-verification result: how many citations were removed as
   * unverifiable, with de-duplicated reasons. Renders a muted note under the
   * sources row when present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * The turn's research was CUT OFF at its tool-iteration ceiling: the answer
   * rests on the evidence gathered up to that point, not on a finished search.
   * Present or absent, never false. Independent of `answerConfidence` — a
   * truncated answer can be perfectly grounded in the little it did find.
   */
  researchTruncated?: true
  /**
   * WHY the research stopped early, as a stable token the dictionary turns into
   * words. Read independently of `researchTruncated`: the flag and its cause
   * are separate facts on the wire, and a cause without a flag says nothing.
   */
  truncationReason?: string
  /**
   * Ways this answer came out weaker than a healthy run, as stable tokens.
   * Absent rather than empty — an empty list is not a claim.
   */
  degradedReasons?: string[]
  /**
   * Skills whose instructions the agent LOADED while answering, in activation
   * order. Renders the "skills used" disclosure under the answer; absent when
   * the turn activated none.
   */
  skillsActivated?: string[]
  /** The grid-hidden subset of skillsActivated — muted in the disclosure, never dropped. */
  skillsHidden?: string[]
  /**
   * The WS turn id (`parent_id`) this answer belongs to
   * (`docs/architecture/post-answer-stages.md` §1.6, §4.1).
   *
   * There are THREE independent id spaces for one turn: this message's row id
   * (minted here, a uuid4), the user message's row id, and the WS turn id the
   * client mints as `msg_${Date.now()}_${counter}`. The agent tier only ever
   * sees the third, so it is the only id both halves genuinely share — and
   * therefore the only correlation key a post-answer stage frame can carry.
   *
   * Browser-local by design: it is a handle on a live socket's turn, not a fact
   * about the answer, so it is never persisted to the message row. A frame that
   * matches no message in this tab is dropped, which is the correct outcome for
   * a turn this tab did not ask.
   */
  wsParentId?: string
  /**
   * What a POST-ANSWER STAGE computed for this turn, arriving after the answer
   * (`docs/architecture/post-answer-stages.md` §4.3).
   *
   * One key per stage. Not `cards`: a stage's output is not a card, is not
   * placed by a marker, and — the reason that matters — is never exported into
   * an Einreichung, which anything under `cards` is by the generic walker.
   */
  stages?: MessageStages
}

/** Intermediate thinking step from agent */
export interface IntermediateStep {
  id: string
  name: string
  status: 'in_progress' | 'complete' | 'error'
  content: string
  timestamp: Date
}

/** Categories for intermediate step tabs in the thinking panel */
export type IntermediateStepCategory = 'tasks' | 'agents' | 'tools'

/**
 * Compact lane hit surviving storage prune (Herleitung fan-out).
 * Mirrors `TraceLaneCard` in `./lib/trace-lanes` without a circular import.
 */
export interface ThinkingTraceLane {
  key: string
  label: string
  hitCount: number
  sources: Array<{ name: string; detail?: string }>
  /**
   * Canonical coarse source kind (ADR-0026), as classified by the backend.
   * Optional: lanes persisted before the `## Trace-Lanes` block carried it have
   * only `signal`, which stays the field consumers read.
   */
  kind?: SourceKind
  signal: SourceSignal
}

/** Thinking step for the Details Panel Thinking tab */
export interface ThinkingStep {
  /** Unique identifier for this step */
  id: string
  /** ID of the user message that triggered this thinking step */
  userMessageId: string
  /** Category for tab routing (tasks, agents, tools) */
  category: IntermediateStepCategory
  /** Raw function name from backend (e.g., "web_search_tool") */
  functionName: string
  /** Human-readable display name (e.g., "Web Search Tool") */
  displayName: string
  /** Content/output of this step (parsed payload) */
  content: string
  /** Raw payload from backend for debugging */
  rawPayload?: string
  /** When this step started */
  timestamp: Date
  /** Whether this step is complete (Function Complete received) */
  isComplete: boolean
  /** Whether this step is from deep research (for Research Panel routing) */
  isDeepResearch?: boolean
  /** True when backend name is "Function Start: ..." (top-level workflow step); false for model/tool sub-calls (indented) */
  isTopLevel?: boolean
  /**
   * Compact Herleitung lane cards derived from tool output. Survives content
   * stripping on localStorage prune so the sources fan-out remains after reload.
   */
  traceLanes?: ThinkingTraceLane[]
  /**
   * What this step SEARCHED FOR, as the key and values the backend stated —
   * never a rendered sentence, because a sentence has a language and the reader
   * picked theirs.
   *
   * Derived at prune time for the same reason `traceLanes` is: the payload it
   * comes from is stripped for storage, so without this the Herleitung of a
   * reopened conversation loses the one fact that made it worth opening.
   */
  searchTrail?: Array<{ key: string; values?: Record<string, string> }>
}

/** Conversation/Session */
export interface Conversation {
  id: string
  /** Owner of this session - used to filter sessions by user */
  userId: string
  /**
   * Project this session belongs to. null/undefined marks a legacy unscoped
   * session which fails OPEN (visible in every project context) — see
   * `lib/project-scope.ts` for the rule.
   */
  projectId?: string | null
  /**
   * The job that produced this session, when one did (`conversations.job_id`,
   * migration 0044); null/undefined for every session a person started, which
   * is nearly all of them.
   *
   * Provenance, NOT ownership — `userId` above is still a membership marker and
   * still says nothing about authorship. This is the only field that says
   * "nobody typed this", and it is what keeps a job's threads out of the
   * personal sessions list (`lib/project-scope.ts`, `isJobConversation`) while
   * leaving them openable by URL and from the job's run history.
   */
  jobId?: string | null
  title: string
  /**
   * What this thread is asking about, when it started from a file (same Ask
   * Piloti as `?ask=`). Null for an ordinary chat.
   */
  subjectResourceType?: 'document' | null
  subjectResourceId?: string | null
  messages: ChatMessage[]
  createdAt: Date
  updatedAt: Date
  /** Per-session enabled data source IDs (persisted across refresh) */
  enabledDataSourceIds?: string[]
}

/** Pending human interaction from agent */
export interface PendingInteraction {
  /** Unique ID for this interaction */
  id: string
  /** Parent message ID for response */
  parentId: string
  /** Type of input expected */
  inputType: HumanPromptInputType
  /** Prompt text */
  text: string
  /** Options for choice prompts */
  options?: string[]
  /** Default value for text input */
  defaultValue?: string
}

/** Deep research job status (from SSE stream) */
export type DeepResearchJobStatus = 'submitted' | 'running' | 'success' | 'failure' | 'interrupted'

/** Citation source from research (deep SSE or shallow WS ``sources``). */
export interface CitationSource {
  id: string
  /**
   * Outbound URL when the source is web/RIS. Optional for KB hits that only
   * have a citation key / file locator (structured wire).
   */
  url?: string
  content: string
  timestamp: Date
  /** Whether this source was actually cited in the report (vs just referenced/discovered) */
  isCited?: boolean
  /** Backend origin token without brackets: kb | ris | web */
  origin?: 'kb' | 'ris' | 'web'
  /**
   * The `[N]` marker this source carries in the answer prose, when the backend
   * resolved one (`verify_citations` owns that binding). Lets the provenance
   * block render as the answer's numbered source list — one block instead of a
   * written list plus an unnumbered chip row. Absent on legacy/persisted
   * messages and on the deep-research SSE path.
   */
  number?: number
  title?: string
  citationKey?: string
  collection?: string
  sourceType?: string
  tool?: string
  /** Document filename from structured wire (prefer over parsing content). */
  fileName?: string
  /** 1-based page from structured wire. */
  page?: number
  /**
   * Coarse source kind (baurecht | buero | projekt | web) — the canonical
   * taxonomy that drives the chip color family (ADR-0026). Absent on older
   * persisted messages, which fall back to origin/URL heuristics.
   */
  kind?: SourceKind
  /**
   * The SHELF the retrieved chunk came from (`archiv | project | session |
   * base`, ADR-0047) — a separate axis from `kind` above, carried explicitly so
   * no consumer has to prefix-match the collection id or parse a German label.
   * Absent on messages persisted before the wire carried it (and during the
   * BFF/agent rollout), where it reads as unknown — never as a default shelf.
   */
  shelf?: Shelf
  /**
   * Identity of the DOCUMENT this source is a passage of, as the backend
   * registry groups it (`citation_verification.document_key`). Absent on
   * messages persisted before the wire carried it, where the client derives an
   * equivalent key from filename/collection instead.
   */
  documentId?: string
  /** Fine lane stratum-key (baurecht_oib, baurecht_ris, …) — drives the authority badge. */
  lane?: string
  /** Human lane label ("OIB-Richtlinie", "Rechtsquelle (RIS)") for the popover. */
  laneLabel?: string
  /**
   * Bindingness note ("Macht die OIB-Richtlinien in Wien verbindlich: …") for a
   * RIS source the norm registry catalogues — shown in the source popover so an
   * architect can see whether the source actually binds their project.
   */
  bindingNote?: string
  /**
   * Coarse binding classification the backend derived from the norm registry
   * (`bindend` / `verbindlich_erklaert` / `auslegend` / `unbekannt`). Distinct
   * from `authority`, which names the TIER (OIB / RIS); this names whether the
   * source BINDS. `unbekannt` is dropped to undefined at the wire boundary so a
   * missing classification reads as "not known", never as "not binding" — the
   * one direction a legal signal must not fail in.
   */
  bindingStatus?: string
}

/** Wire shape of a structured source attached to a shallow ChatResponse. */
export interface WireCitationSource {
  content?: string
  url?: string | null
  title?: string | null
  citation_key?: string | null
  collection?: string | null
  source_type?: string | null
  tool?: string | null
  origin?: string | null
  /** Citation label ([N]) this source carries in the answer prose. */
  number?: number | null
  /** Backend identity of the document this source is a passage of. */
  document_id?: string | null
  file_name?: string | null
  page?: number | null
  kind?: string | null
  /** Shelf the chunk came from: `archiv | project | session | base` (ADR-0047). */
  shelf?: string | null
  lane?: string | null
  lane_label?: string | null
  binding_note?: string | null
  /**
   * Coarse binding status the backend classified this source as:
   * `bindend` (statute/ordinance) | `verbindlich_erklaert` (OIB-Richtlinie /
   * the lane a Land declares binding) | `auslegend` (Leitfaden/ÖNORM,
   * interpretive) | `unbekannt` (matched no catalogued norm — the honest
   * default, never a guess). Rides the `sources` schema's `.passthrough()`;
   * declared here so the renderer can badge it. Structured companion to the
   * prose `binding_note`.
   */
  binding_status?: string | null
}

/** Plan message for chat/HITL display and restore flows */
export interface PlanMessage {
  id: string
  /** The text content (clarification question, plan preview, etc.) */
  text: string
  /** Input type expected from user (if any) */
  inputType?: HumanPromptInputType
  /** Placeholder for text input */
  placeholder?: string
  /** Whether input is required */
  required?: boolean
  /** User's response to this message (if applicable) */
  userResponse?: string
  /** When this message was received */
  timestamp: Date
}

/** Todo item status from deep research SSE */
export type DeepResearchTodoStatus = 'pending' | 'in_progress' | 'completed' | 'stopped'

/** Todo item from deep research (artifact.update with type: "todo") */
export interface DeepResearchTodo {
  /** Unique identifier (generated from content hash) */
  id: string
  /** Task content/description */
  content: string
  /** Current status */
  status: DeepResearchTodoStatus
}

/** LLM step for ThoughtTracesTab (from llm.start/end) */
export interface DeepResearchLLMStep {
  /** Unique identifier */
  id: string
  /** LLM model name */
  name: string
  /** Parent workflow (metadata.workflow) */
  workflow?: string
  /** Streaming/final output content */
  content: string
  /** Chain-of-thought reasoning (metadata.thinking) */
  thinking?: string
  /** Token usage (from llm.end metadata.usage) */
  usage?: { input_tokens: number; output_tokens: number }
  /** When LLM started */
  timestamp: Date
  /** Whether LLM call is complete */
  isComplete: boolean
}

/** Agent step for AgentsTab (from workflow.start/end) */
export interface DeepResearchAgent {
  /** Unique identifier */
  id: string
  /** Agent/workflow name (e.g., "planner-agent", "researcher-agent") */
  name: string
  /** Input provided to agent (data.input) */
  input?: string
  /** Output from agent (data.output) */
  output?: string
  /** Current execution status */
  status: 'running' | 'complete' | 'error'
  /** When agent started */
  startedAt: Date
  /** When agent completed */
  completedAt?: Date
}

/** Tool call for ToolCallsTab (from tool.start/end) */
export interface DeepResearchToolCall {
  /** Unique identifier */
  id: string
  /** Tool name (e.g., "tavily_web_search", "write_file") */
  name: string
  /** Structured tool input arguments */
  input?: Record<string, unknown>
  /** Tool output/result (after tool.end) */
  output?: string
  /** Parent workflow that invoked the tool */
  workflow?: string
  /** Parent agent ID that invoked the tool (for grouping under agents) */
  agentId?: string
  /** Current execution status */
  status: 'running' | 'complete' | 'error'
  /** When tool was called */
  timestamp: Date
}

/** File artifact for FilesTab (from artifact.update type: "file") */
export interface DeepResearchFile {
  /** Unique identifier */
  id: string
  /** File name/path */
  filename: string
  /** File content */
  content: string
  /** When file was created/updated */
  timestamp: Date
}

/** Chat state for Zustand store */
export interface ChatState {
  /** Current authenticated user ID - used for filtering sessions */
  currentUserId: string | null
  /** Current active conversation */
  currentConversation: Conversation | null
  /** All conversations for the sessions sidebar (includes all users) */
  conversations: Conversation[]
  /**
   * True while an interrupted-answer recovery fetch is in flight (FIX 3). Shows
   * the calm "reconnecting — checking for a finished answer" copy instead of
   * racing straight to the "answer lost" notice; the lost/interrupted UI only
   * appears once this settles to false with nothing recovered.
   */
  isRecoveryPending: boolean
  /**
   * Whether the server conversation list has been asked for at least once. A
   * `?session=<id>` deep link needs this to tell "stale id" from "not fetched
   * yet" before it strips itself from the URL (see the sessions slice).
   */
  serverConversationsLoaded: boolean
  /** Whether a message is currently streaming */
  isStreaming: boolean
  /** Whether we're waiting for the first response token */
  isLoading: boolean
  /** ID of the current user message being processed (for associating thinking steps) */
  currentUserMessageId: string | null
  /**
   * The WS turn id (`parent_id`) of the turn in flight — the twin of
   * `currentUserMessageId` in the id space the AGENT tier owns
   * (`docs/architecture/post-answer-stages.md` §1.6). The answer bubble is
   * stamped with it as it is built, so a post-answer stage frame, which knows
   * only the turn, can find the message it belongs to. Null between turns.
   */
  currentTurnWsParentId: string | null
  /** Thinking steps for the Details Panel - Thinking tab */
  thinkingSteps: ThinkingStep[]
  /** ID of the currently active thinking step (for appending content) */
  activeThinkingStepId: string | null
  /**
   * ID of the assistant `agent_response` bubble currently accumulating streamed
   * answer deltas for the active turn. Set on the first `in_progress` delta,
   * cleared when the turn finalizes (terminal `complete` frame) or a new user
   * turn begins. Null when no answer is mid-stream. This is what keeps N delta
   * frames collapsing into ONE bubble instead of appending a fresh bubble per
   * frame.
   */
  streamingAssistantMessageId: string | null
  /** Active project ID for scoping (set by project chat page) */
  projectId: string | null
  /**
   * One-shot draft text queued for the chat composer (InputArea). Set by deep
   * links (`?ask=`) and welcome-screen suggestion chips; consumed exactly once
   * by the composer. Null when there is nothing to prefill.
   *
   * `mentions` carries the STRUCTURED references a prefill renders as `@…`
   * tokens (e.g. the hand-off banner's "ask Piloti instead"): without them the
   * tokens are dead text and the send routes as a plain message, which is not
   * what the button that queued the prefill promised (spec MN-3 — a mention is
   * never re-derived from text).
   */
  composerPrefill: ComposerPrefill | null
  /**
   * What this draft/session is asking about. Survives the one-shot prefill
   * consume so the composer chip stays up. Same Ask Piloti as `?ask=`.
   *
   * A peek-bound subject (citation auto-peek / document_grid via
   * `openFilePeek`) lives only while that peek is visible: hide/close MUST
   * clear this. A user-intent subject (`?doc=`) is not peek-bound and
   * survives hide so the bar can restore the file.
   */
  composerSubject: ComposerSubject | null
  /**
   * Per-session composer drafts: the user's own in-progress, unsent text keyed
   * by conversation id. Distinct from `composerPrefill` (one-shot, external):
   * a draft is long-lived, survives session switches and reloads (persisted to
   * the `aiq-chat-store` localStorage namespace), and is cleared only when its
   * message is sent successfully or its session is removed. Keyed by
   * conversation id so it is inherently project/user-scoped and never leaks
   * across contexts.
   */
  composerDrafts: Record<string, string>
  /**
   * Transient live chat send callback registered by InputArea's WebSocket hook
   * (mirrors `respondToInteractionFn`, not persisted). Lets components that do
   * not own the socket — e.g. the retry action on an errored answer in
   * ChatArea — resend through the real send path.
   */
  chatSendFn: ((content: string) => void) | null
  /** Content for the Details Panel - Report tab */
  reportContent: string
  /** Category of the current report content (distinguishes intermediate notes from final report) */
  reportContentCategory: 'research_notes' | 'final_report' | null
  /** Current status type (for status indicators) */
  currentStatus: StatusType | null
  /** Pending interaction requiring user response (for HITL) */
  pendingInteraction: PendingInteraction | null
  /** Transient callback for responding to HITL interactions (registered by InputArea, not persisted) */
  respondToInteractionFn: ((response: string) => void) | null

  // Deep research SSE state
  /** Current deep research job ID (null when not active) */
  deepResearchJobId: string | null
  /** Last SSE event ID received (for reconnection) */
  deepResearchLastEventId: string | null
  /** Whether deep research SSE is currently streaming */
  isDeepResearchStreaming: boolean
  /** Epoch ms when the current live run started in this tab (null after reload) */
  deepResearchStartedAt: number | null
  /** Current deep research job status */
  deepResearchStatus: DeepResearchJobStatus | null
  /** Conversation ID that owns the current deep research stream (for session isolation) */
  deepResearchOwnerConversationId: string | null
  /** Message ID of the originating deep research message (for patching on completion) */
  activeDeepResearchMessageId: string | null
  /** Citations collected during deep research */
  deepResearchCitations: CitationSource[]
  /** Todo items from deep research (from artifact.update with type: "todo") */
  deepResearchTodos: DeepResearchTodo[]
  /** LLM steps for ThoughtTracesTab (from llm.start/end events) */
  deepResearchLLMSteps: DeepResearchLLMStep[]
  /** Agent steps for AgentsTab (from workflow.start/end events) */
  deepResearchAgents: DeepResearchAgent[]
  /** Tool calls for ToolCallsTab (from tool.start/end events) */
  deepResearchToolCalls: DeepResearchToolCall[]
  /** File artifacts for FilesTab (from artifact.update type: "file" events) */
  deepResearchFiles: DeepResearchFile[]
  /** Grid response cards attached to the final deep-research report */
  deepResearchCards: GridCard[]
  /** Whether the full stream data (artifacts, tool calls, etc.) has been loaded for current job */
  deepResearchStreamLoaded: boolean
  /** Live stream is open but has gone quiet (no events for a while) — UX-11a */
  isDeepResearchStalled: boolean
  /** SSE retries exhausted: stream is gone but the job may still run server-side — UX-11b */
  deepResearchConnectionLost: boolean
  /** Transient reconnect handler registered by useDeepResearch (not persisted) */
  reconnectDeepResearchFn: (() => void) | null

  // Plan state (for chat/HITL restore flows)
  /** Messages for clarification questions, plan previews, and approvals. */
  planMessages: PlanMessage[]
}

/** Chat actions for Zustand store */
export interface ChatActions {
  /**
   * Load conversations from the server and merge with local state.
   * Pass a projectId to fetch that project's conversations (plus legacy
   * unscoped rows) — used when entering a project chat.
   */
  loadServerConversations: (projectId?: string) => Promise<void>
  /**
   * Repopulate a conversation's messages from the server-persisted history
   * when the local copy is empty (localStorage cleanup, new device). No-op
   * for sessions that already have local messages.
   */
  hydrateConversationMessages: (conversationId: string) => Promise<void>
  /** Set the current authenticated user ID */
  setCurrentUser: (userId: string | null) => void
  /**
   * Get conversations filtered by current user AND the active project
   * context (legacy sessions without a projectId fail open — see
   * `lib/project-scope.ts`).
   */
  getUserConversations: () => Conversation[]
  /** Create a new conversation for the current user (stamped with the active projectId) */
  createConversation: () => Conversation
  /** Start a new unsaved session draft; persisted only after first interaction. */
  startNewSessionDraft: () => void
  /** Ensure a session exists, creating one if needed. Returns session ID or undefined if no user. */
  ensureSession: () => string | undefined
  /** Select a conversation (only if owned by current user and visible in the active project context) */
  selectConversation: (conversationId: string) => void
  /** Add a user message to the current conversation */
  addUserMessage: (
    content: string,
    metadata?: {
      enabledDataSources?: string[]
      messageFiles?: Array<{ id: string; fileName: string }>
    }
  ) => ChatMessage
  /** Start streaming an assistant response */
  startAssistantMessage: () => ChatMessage
  /** Append content to the streaming assistant message */
  appendToAssistantMessage: (content: string) => void
  /** Complete the streaming assistant message */
  completeAssistantMessage: () => void
  /** Set loading state */
  setLoading: (loading: boolean) => void
  /** Set streaming state */
  setStreaming: (streaming: boolean) => void
  /**
   * User-initiated cancel of the in-flight turn: flush batched deltas, finalize
   * the current streaming bubble, clear isStreaming/isLoading/currentStatus, and
   * trigger the websocket teardown. [C1]
   */
  stopStreaming: () => void
  /** Delete a conversation */
  deleteConversation: (conversationId: string) => void
  /**
   * Delete all of the current user's conversations in the active project
   * context — exactly what the sessions panel shows there. Sessions stamped
   * with a different project are never touched.
   */
  deleteAllConversations: () => void
  /** Update conversation title */
  updateConversationTitle: (conversationId: string, title: string) => void
  /**
   * ChatGPT-style naming: after the first answer completes, generate a concise
   * title + OIB topic tags for the conversation from its opening exchange.
   * Fires at most once per conversation; best-effort (keeps the provisional
   * title on failure).
   */
  maybeGenerateConversationName: (conversationId: string) => void
  /** Persist enabled data source IDs to the current conversation for per-session storage */
  saveDataSourcesToConversation: (ids: string[]) => void

  // New actions for thinking/report content and status/prompts

  /** Add a new thinking step to the Details Panel with category and metadata */
  addThinkingStep: (step: Omit<ThinkingStep, 'id' | 'timestamp' | 'userMessageId'>) => string
  /** Get thinking steps filtered by user message ID */
  getThinkingStepsForMessage: (userMessageId: string) => ThinkingStep[]
  /** Append content to an existing thinking step */
  appendToThinkingStep: (stepId: string, content: string) => void
  /** Mark a thinking step as complete */
  completeThinkingStep: (stepId: string) => void
  /** Update or complete a thinking step by function name (for "Function Complete" messages) */
  updateThinkingStepByFunctionName: (
    functionName: string,
    content: string,
    isComplete: boolean
  ) => void
  /** Find a thinking step by function name */
  findThinkingStepByFunctionName: (functionName: string) => ThinkingStep | undefined
  /** Set the report content with optional category */
  setReportContent: (content: string, category?: 'research_notes' | 'final_report') => void
  /** Clear all thinking steps (for new request) */
  clearThinkingSteps: () => void
  /** Clear report content (for new request) */
  clearReportContent: () => void
  /** Set current status type */
  setCurrentStatus: (status: StatusType | null) => void
  /** Add an agent prompt message to the conversation */
  addAgentPrompt: (
    type: PromptType,
    content: string,
    options?: string[],
    placeholder?: string,
    promptId?: string,
    parentId?: string,
    inputType?: HumanPromptInputType
  ) => void
  /** Respond to a prompt */
  respondToPrompt: (messageId: string, response: string) => void

  // Actions for agent responses and HITL

  /** Add an agent response message to the chat (for short answers) */
  addAgentResponse: (
    content: string,
    showViewReport?: boolean,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  /**
   * Accumulate a streamed answer delta (`in_progress` content frame) into a
   * single assistant bubble for the active turn. Creates the bubble on the
   * first delta and appends text on each subsequent one. Meta (cards/
   * confidence/citations) is normally absent on deltas but merged when present
   * so the legacy single-`in_progress`-frame path (full text + cards on one
   * delta) still attaches its cards.
   */
  appendAgentResponseDelta: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[]
  ) => void
  /**
   * Finalize the accumulating answer bubble on the terminal `complete` frame:
   * replace its content with the authoritative full text (idempotent — equals
   * the accumulation), attach cards/sources/confidence, and mark it final. An
   * EMPTY terminal (the legacy synthetic `complete` frame) keeps the
   * accumulated text rather than wiping it. Falls back to a one-shot
   * `addAgentResponse` when no delta ever opened a bubble.
   */
  finalizeAgentResponse: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  /**
   * Record which WS turn the answer being built belongs to. Idempotent within a
   * turn — every frame of a turn carries the same `parent_id`.
   */
  setTurnWsParentId: (wsParentId: string) => void
  /**
   * Apply a post-answer stage frame to the turn it addresses
   * (`docs/architecture/post-answer-stages.md` §4.3, §8).
   *
   * Declines the frame — silently, and normally — when it addresses no message
   * here, when the answer is still streaming, when anything sits below that
   * answer in the thread, or when the reader has started typing. Returns the id
   * of the message it landed on when something was stored, so the caller can
   * mirror it to the server; null otherwise.
   */
  applyStageFrame: (frame: StageFrame) => string | null
  /**
   * Drop the in-progress streaming assistant bubble of the current turn
   * entirely (message removed, not finalized) and clear
   * `streamingAssistantMessageId`. Used when a turn resolves in a surface other
   * than an answer bubble — e.g. a job-admission rejection rendered as a banner
   * — so any orphaned bubble opened by earlier deltas leaves no lingering caret.
   * No-op when no streaming bubble is open.
   */
  discardStreamingAssistantMessage: () => void
  /** Add an agent response with additional metadata - returns the created message ID */
  addAgentResponseWithMeta: (
    content: string,
    showViewReport: boolean,
    meta: Partial<ChatMessage>,
    cards?: GridCard[]
  ) => string
  /** Patch a specific message in a conversation */
  patchConversationMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>
  ) => void
  /**
   * Record the user's answer to one interactive card of an answer (see
   * `features/grid-cards/card-decision.ts`). Writes it onto the owning message
   * — persisting it to localStorage through the store's `persist` middleware —
   * and mirrors it to the server message row so the decision also survives a
   * storage wipe or a different device. No-op when the message is unknown.
   */
  setCardDecision: (messageId: string, cardKey: string, decision: CardDecision) => void
  /** Set pending interaction requiring user response */
  setPendingInteraction: (interaction: PendingInteraction | null) => void
  /** Clear pending interaction (after user responds) */
  clearPendingInteraction: () => void
  /** Register the respondToInteraction callback (called by InputArea on mount) */
  setRespondToInteractionFn: (fn: ((response: string) => void) | null) => void

  // Actions for file and error cards

  /** Add a file card message to the conversation */
  addFileCard: (data: FileCardData) => void
  /** Update file card status (for progress updates) */
  updateFileCard: (messageId: string, data: Partial<FileCardData>) => void
  /** Add an error card message to the conversation */
  addErrorCard: (code: ErrorCode, message?: string, details?: string) => void
  /** Dismiss an error card */
  dismissErrorCard: (messageId: string) => void
  /** Dismiss all connection error cards (connection.*) from the current conversation */
  dismissConnectionErrors: () => void

  /**
   * Add a deep research banner (starting, success, or failure) to a conversation.
   * If conversationId is provided, adds to that specific conversation.
   * Otherwise, adds to the current conversation.
   * For 'starting' banners, job metadata is automatically set for session restoration.
   */
  addDeepResearchBanner: (
    bannerType: DeepResearchBannerType,
    jobId: string,
    conversationId?: string,
    stats?: { totalTokens?: number; toolCallCount?: number },
    escalationReason?: string
  ) => void

  /**
   * Record that a run's report was filed into the project, on that run's
   * success banner.
   *
   * Separate from `addDeepResearchBanner` because the two facts arrive at
   * different times and over different transports: the banner is written from
   * the SSE stream the moment the run succeeds, and the filing is only known
   * once the report route has been asked for the report (that GET is where the
   * BFF observes completion and files the document). Folding it into the banner
   * call would mean holding the banner back until a second request returns,
   * which would delay the outcome the user is waiting for to decorate it.
   *
   * A no-op when no success banner for `jobId` exists — an attached run has no
   * thread to write into.
   */
  recordDeepResearchFiling: (jobId: string, filed: DeepResearchFiledDocument) => void

  /**
   * Record that a filing this run's starting banner promised did NOT land.
   *
   * The counterpart to `recordDeepResearchFiling`, and it exists because the
   * absence of a filing means two different things. The report route reports
   * them apart — `filed` when the document exists, `filingFailed` when a
   * project was resolved and the write still failed — and only the second one
   * contradicts something the reader was already told.
   *
   * Never overrides a recorded document: see the action's own comment.
   *
   * A no-op when no success banner for `jobId` exists.
   */
  recordDeepResearchFilingFailure: (jobId: string) => void

  // Deep research SSE actions

  /** Start deep research streaming with a job ID and optional originating message ID */
  startDeepResearch: (jobId: string, messageId?: string) => void
  /**
   * Follow a run this session did not start (a workflow run, or one opened from
   * the run history): binds the job so its SSE stream connects and the research
   * panel updates live — without an owning conversation or tracking message.
   */
  attachToDeepResearchJob: (jobId: string) => void
  /** Update deep research job status */
  updateDeepResearchStatus: (status: DeepResearchJobStatus) => void
  /** Update the last received SSE event ID (for reconnection) */
  setDeepResearchLastEventId: (eventId: string | null) => void
  /** Persist current deep research state to sessionStorage (for page refresh) */
  persistDeepResearchToSession: () => void
  /** Complete deep research (clears streaming state, keeps content) */
  completeDeepResearch: () => void
  /** Mark the live stream as stalled (open but silent) or clear it — UX-11a */
  setDeepResearchStalled: (stalled: boolean) => void
  /** Mark the SSE connection as lost (retries exhausted) or clear it — UX-11b */
  setDeepResearchConnectionLost: (lost: boolean) => void
  /** Register/clear the reconnect handler surfaced by useDeepResearch */
  setReconnectDeepResearchFn: (fn: (() => void) | null) => void
  /** Save current deep research progress to conversation (for session switching) */
  saveDeepResearchProgress: () => void
  /** Reconnect to an in-progress job after page refresh (running/submitted only) */
  reconnectToActiveJob: () => Promise<void>
  /** Clean up orphaned 'starting' banners by polling job status via REST */
  cleanupOrphanedStartingBanners: () => Promise<void>
  /**
   * Refresh persisted deep-research job metadata without deleting the chat
   * session. Missing backend jobs are represented as expired report state when
   * the session previously had a completed report.
   */
  refreshDeepResearchSessionStatuses: () => Promise<void>
  /**
   * Add a citation from deep research (isCited=true for citation_use, false for
   * citation_source). Takes the backend citation wire whole and normalizes it
   * with `citationFromWire` — the same single normalizer the shallow-chat path
   * uses, so both transports produce identical CitationSource objects.
   */
  addDeepResearchCitation: (wire: WireCitationSource, isCited?: boolean) => void
  /** Set the full todo list from deep research (replaces existing) */
  setDeepResearchTodos: (todos: Array<{ content: string; status: string }>) => void
  /** Mark all in-progress and pending todos as stopped (on error) */
  stopDeepResearchTodos: () => void
  /** Stop all spinners (todos, LLM steps, agents, tool calls). Pass true for success, false/undefined for error. */
  stopAllDeepResearchSpinners: (isSuccessfulCompletion?: boolean) => void
  /** Clear all deep research state (for new research) */
  clearDeepResearch: () => void
  /** Set job ID for loaded (non-streaming) report data - enables cache lookup */
  setLoadedJobId: (jobId: string) => void
  /** Mark that full stream data has been loaded for current job */
  setStreamLoaded: (loaded: boolean) => void

  // Deep research ThinkingTab actions (LLM steps, agents, tool calls, files)

  /** Add a new LLM step (on llm.start) */
  addDeepResearchLLMStep: (
    step: Omit<DeepResearchLLMStep, 'id' | 'timestamp' | 'isComplete'>
  ) => string
  /** Append content to an LLM step (on llm.chunk) */
  appendToDeepResearchLLMStep: (stepId: string, content: string) => void
  /** Complete an LLM step with thinking and usage (on llm.end) */
  completeDeepResearchLLMStep: (
    stepId: string,
    thinking?: string,
    usage?: { input_tokens: number; output_tokens: number }
  ) => void
  /** Add a new agent (on workflow.start) */
  addDeepResearchAgent: (agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>) => string
  /** Add a new agent with a specific ID (for linking with tool calls) */
  addDeepResearchAgentWithId: (
    id: string,
    agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>
  ) => string
  /** Complete an agent (on workflow.end) */
  completeDeepResearchAgent: (agentId: string, output?: string) => void
  /** Add a new tool call (on tool.start) */
  addDeepResearchToolCall: (
    toolCall: Omit<DeepResearchToolCall, 'id' | 'timestamp' | 'status'>
  ) => string
  /** Complete a tool call (on tool.end) */
  completeDeepResearchToolCall: (toolCallId: string, output?: string) => void
  /** Get tool calls for a specific agent */
  getAgentToolCalls: (agentId: string) => DeepResearchToolCall[]
  /** Add a file artifact (on artifact.update type: "file") */
  addDeepResearchFile: (file: Omit<DeepResearchFile, 'id' | 'timestamp'>) => string
  /** Validate and set Grid cards from the final deep-research report artifact */
  setDeepResearchCards: (cards: unknown) => void

  // Plan actions (for chat/HITL restore flows)

  /** Add a plan message (clarification, plan preview, etc.) */
  addPlanMessage: (message: Omit<PlanMessage, 'id' | 'timestamp'>) => string
  /** Update a plan message with user response */
  updatePlanMessageResponse: (messageId: string, response: string) => void
  /** Clear all plan messages (for new request) */
  clearPlanMessages: () => void
  /** Persist current planMessages to the conversation for HITL recovery */
  persistPlanMessages: () => void

  // Session restoration

  /** Restore ephemeral state (thinkingSteps, reportContent, citations) from a conversation's messages */
  restoreSessionState: (conversation: Conversation) => void

  /**
   * Refetch server-persisted history for a seemingly-interrupted turn and, if
   * the backend persisted the assistant reply while the client was disconnected,
   * append it locally. Returns true when a reply was recovered (so the caller
   * can skip the "response interrupted" banner).
   */
  _recoverInterruptedAssistantMessage: (
    conversationId: string,
    afterUserMessageId: string
  ) => Promise<boolean>

  // Session busy checks (for disabling UI controls)

  /**
   * Check if a specific session has active operations.
   * Scans message history for background jobs - the only way to detect jobs in non-current sessions.
   * @param conversationId - The conversation ID to check
   * @returns true if the session has active operations (shallow or deep research)
   */
  isSessionBusy: (conversationId: string) => boolean
  /**
   * Check if ANY session has active operations.
   * Used to disable "Delete All Sessions" button.
   * @returns true if any session has active operations
   */
  hasAnyBusySession: () => boolean

  /** Ensure the current conversation record exists on the server */
  _ensureConversationExists: () => Promise<void>
  /** Append a single message to the server for the current conversation */
  _appendMessage: (message: ChatMessage) => Promise<void>
  /**
   * Mirror a message's card decisions to its server row. Best-effort: the local
   * store is already the authoritative copy, so a failure here only costs the
   * cross-device/after-a-storage-wipe replay and is logged, never surfaced.
   */
  _persistCardInteractions: (
    conversationId: string,
    messageId: string,
    cardInteractions: CardInteractions
  ) => Promise<void>
  /**
   * Mirror the settled turn's provenance to its server rows (ADR-0037): the
   * Herleitung onto the user message, the confidence and routing transparency onto
   * the assistant message.
   *
   * Best-effort, like the card mirror. Without it a colleague — who holds no agent
   * socket by design — sees a bare answer, and the asker loses the reasoning on any
   * other device.
   */
  _persistTurnProvenance: () => Promise<void>
  /**
   * Mirror the answer to a human-in-the-loop prompt onto its message row, so the
   * transcript records what was decided and a colleague's reload sees it settled.
   */
  _persistPromptState: (messageId: string, response: string) => Promise<void>
  /**
   * Mirror a post-answer stage's output onto its message row
   * (`docs/architecture/post-answer-stages.md` §4.3). Best-effort, like the
   * other mirrors: the chips are already rendered from the store, so losing it
   * costs the replay, not the turn.
   */
  _persistStageOutput: (messageId: string, stages: MessageStages) => Promise<void>

  /** Set the active project ID for collection scoping */
  setProjectId: (projectId: string | null) => void

  /** Queue text for the composer to pick up (does NOT auto-send). */
  setComposerPrefill: (text: string, mentions?: DraftMention[], subject?: ComposerSubject) => void
  setComposerSubject: (subject: ComposerSubject | null) => void
  /** Read and clear the queued composer prefill; returns null when empty. */
  consumeComposerPrefill: () => ComposerPrefill | null
  /** Register the live chat send callback (called by InputArea on mount). */
  setChatSendFn: (fn: ((content: string) => void) | null) => void
  /** Resend the current conversation's last user message (retry affordance). */
  retryLastUserMessage: () => void

  /** Save (or update) the in-progress composer draft for a session. Passing an empty string drops the entry. */
  setComposerDraft: (conversationId: string, text: string) => void
  /** Read the persisted composer draft for a session ('' when none). */
  getComposerDraft: (conversationId: string) => string
  /** Drop a session's composer draft (on successful send or session removal). */
  clearComposerDraft: (conversationId: string) => void
}

/** Combined chat store type */
export type ChatStore = ChatState & ChatActions
