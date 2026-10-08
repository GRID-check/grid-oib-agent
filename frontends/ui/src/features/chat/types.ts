/**
 * Chat Feature Types
 *
 * Type definitions for chat messages, conversations, and state.
 */

import type { PageRegion } from '@/features/knowledge/lib/page-region'
import type { GridCard } from '@/shared/cards/schemas'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import type {
  AnswerConfidenceCappedReason,
  StoredThinkingStep,
} from '@/lib/conversations/message-provenance'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { Findings } from '@/lib/conversations/message-findings'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { QuoteStamp } from '@/lib/conversations/message-quote-stamps'
import type { RunLedger } from '@/lib/runs/run-ledger-types'
import type { MessageStages } from '@/lib/conversations/message-stages'
import type { StoredPromptOption } from '@/lib/conversations/message-prompt'
import type { MessagesSlice } from './stores/messages-store'
import type { SessionsSlice } from './stores/sessions-store'
import type { InteractionSlice } from './stores/interaction-store'

import type { Shelf, SourceKind } from './lib/source-kinds'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'

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
  /**
   * The subject's OPEN version — the one still being worked on — when it has
   * one, so the turn can read a document retrieval cannot see.
   *
   * Only a published version reaches the retrieval index (ADR-0054), so a
   * draft, an in-review or a changes-requested document has no chunks and the
   * focus filter falls open to the whole corpus. These two fields travel to the
   * agent as ``focus_version_id`` / ``focus_version_state``; it reads the
   * version's bytes into the conversation's working directory instead.
   *
   * Absent means "the live bytes are the published ones" and nothing changes.
   */
  versionId?: string | null
  versionState?: DocumentVersionState | null
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

/** File status for file operations */
export type FileStatus = 'uploading' | 'ingesting' | 'success' | 'deleted' | 'error'

/** Error codes using dot-notation for extensibility */
export type ErrorCode =
  // Connection errors
  | 'connection.lost'
  | 'connection.failed'
  | 'connection.timeout'
  // The server speaks a newer wire than this page (close code 4426): reload.
  | 'connection.client_outdated'
  // The server does not speak this page's wire (no v2 hello): a deploy fault, not the network.
  | 'connection.server_incompatible'
  // Auth errors
  | 'auth.session_expired'
  | 'auth.unauthorized'
  // Agent errors
  | 'agent.response_failed'
  | 'agent.response_interrupted'
  | 'agent.workflow_error'
  // The provider refused under the org's zero-data-retention policy: the model
  // has no ZDR endpoint. Not retryable until an admin picks a ZDR model.
  | 'agent.zdr_refused'
  // Research errors
  // Deep-research job could not be admitted (queue full). Warning-styled, and
  // NON-locking: the composer stays usable so the user can retry.
  | 'research.queue_full'
  // Budget errors
  | 'budget.exhausted'
  // System errors
  | 'system.unknown'

/** Prompt types for agent prompts requiring user response */
/**
 * What happened when the client asked the server for a turn's finished answer.
 *
 * A boolean could not carry this, and the missing distinction was a bug: two
 * different "false"s meant "the server has nothing" and "the answer is already
 * on screen, someone else fetched it". Recovery runs from three places — on
 * mount, on reconnect, and when the streaming watchdog gives up — and any two
 * of them can be in flight at once, so the second one back would print
 * „bitte erneut senden" underneath the answer the first had just recovered.
 *
 * - `recovered`  — the server had it and it is now in the conversation.
 * - `superseded` — do not tell the reader anything: either the answer is
 *                  already local, or a newer turn is streaming over it.
 * - `nothing`    — no answer exists for this turn. This is the only outcome
 *                  that earns the interrupted banner.
 */
export type RecoveryOutcome = 'recovered' | 'superseded' | 'nothing'

/** A question a reload cut off mid-answer: its turn is the question's own id. */
export interface ResumableTurn {
  conversationId: string
  turnId: string
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
  /** The `interaction_id` of a HITL prompt message. */
  promptId?: string
  /** The turn the prompt belongs to (the question's id). */
  promptParentId?: string
  /** What the prompt asks for: typed text, or one of `promptOptions`. */
  promptInputType?: 'text' | 'choice'
  /** The choices of a `choice` prompt; the answer is the chosen option's `id`. */
  promptOptions?: StoredPromptOption[]
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

  // Session persistence fields (embedded in messages for localStorage persistence)

  /** The turn's Herleitung, on the question it answers, exactly as it is persisted. */
  thinkingSteps?: StoredThinkingStep[]
  /** Citations/sources used (for agent_response messages) */
  citations?: CitationSource[]
  /**
   * The backend job behind a run's answer: the pointer a colleague's client
   * uses to find the report and its cards (`features/grid-cards/card-owner`),
   * and the one deep-research field a message still carries. The run itself
   * is read from `runLedger`.
   */
  deepResearchJobId?: string
  /** Data sources that were enabled when this message was sent (for display in thinking panel) */
  enabledDataSources?: string[]
  /** Files that were available when this message was sent (for display in thinking panel) */
  messageFiles?: Array<{ id: string; fileName: string }>
  /** Grid cards rendered with this agent response.
   *
   * Positions are identity (`[[card:N]]` addresses N-1 here): a card the
   * validator rejected leaves an `undefined` hole rather than renumbering the
   * rest — see `validateGridCards`.
   */
  cards?: (GridCard | undefined)[]
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
   * Which path the turn turned out to take, observed after the answer rather
   * than classified before it: `meta` is a direct reply (no source consulted,
   * no self-assessment), `shallow` and `deep` are research, `error` a failed
   * turn. Drives the answer's role tab — a `meta` reply reads as a "Hinweis".
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Narration shown when the turn escalated shallow→deep this turn. */
  escalationReason?: string
  /**
   * How long the answer took, from the question being sent to the answer
   * being final, in milliseconds. Measured by the browser that asked; absent
   * on turns it did not see start (a reload mid-turn, a colleague's question,
   * a row the backend wrote).
   */
  answerDurationMs?: number
  /**
   * Citation-verification result: how many citations were removed as
   * unverifiable, with de-duplicated reasons. Renders a muted note under the
   * sources row when present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * Retrieved-but-uncited documents for this answer (document key +
   * lane/kind + page, no prose). Renders the collapsed "Gelesen, nicht
   * zitiert" disclosure under the answer; absent when everything retrieved
   * was cited.
   */
  readSources?: CitationSource[]
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
   * The answer's structured anatomy (verdict / takeaways / callout) — native
   * answer fields of this message, gated backend-side and sanitized on every
   * write and read (`lib/conversations/message-answer-meta.ts`). Rendered in a
   * fixed layout: verdict above the prose, callout and takeaways after it.
   */
  answerMeta?: AnswerMeta
  /** The report's findings (`lib/conversations/message-findings.ts`), rendered as the Befundmatrix. */
  findings?: Findings
  /**
   * The backend's own account of this turn's retrieval rounds, same sanitize
   * contract as `answerMeta`. The Herleitung spine draws each round's fan from
   * it; persisted with the message so reloads draw the same one.
   */
  retrievalLedger?: RetrievalLedger
  /**
   * The server's check of each quote line `> „…" [N]` against the passages the
   * turn retrieved (`TurnResult.quote_stamps`). The excerpt draws „Wortlaut
   * belegt [N]" from it; same sanitize contract as `retrievalLedger`.
   */
  quoteStamps?: QuoteStamp[]
  /**
   * The account of the RUN this message is (ADR-0062): the phases it walked,
   * the steps it took and what it left behind.
   *
   * Present on exactly one message per run — the one `messages.run_id` names —
   * and absent on every ordinary turn. Same sanitize contract as
   * `retrievalLedger`: written bounded and re-bounded on read, because a run is
   * narrated by a worker and stored as jsonb.
   */
  runLedger?: RunLedger
  /**
   * The run's title, for the block's header: the task's title or the question
   * a deep-research run was asked. Set once by the BFF when the run's message
   * is minted (`metadata.run_title`); absent on every ordinary turn and on a
   * run minted before it was recorded, where the block shows its own word for
   * an untitled run.
   */
  runTitle?: string
  /**
   * The asker pressed Stop and the server cancelled the turn: this is the
   * partial answer it had written, kept and persisted as such
   * (`RUN_FINISHED` with outcome `cancelled`).
   */
  stopped?: true
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
  /**
   * The person may no longer read what this chat drew on (ADR-0085). The server
   * sent no title and the store holds no messages for it; the UI shows a neutral
   * title and "you no longer have the rights". Set by the list and by a 403
   * `RESOURCE_RIGHTS_LOST`, cleared by the next list that says otherwise.
   */
  contentLocked?: boolean
  /** Per-session enabled data source IDs (persisted across refresh) */
  enabledDataSourceIds?: string[]
}

/** The question the agent is waiting on in the open conversation (`interaction_request`). */
export interface PendingInteraction {
  turnId: string
  interactionId: string
  /** `choice`: the answer is an option's `id`; `text`: it is the typed text. */
  input: 'text' | 'choice'
}

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
  /** The Punkt within the document ("3.5.2"), the citation form building law uses. */
  punkt?: string
  /** Retrieval score (cosine similarity) for this passage, when the wire carried one. */
  score?: number
  /**
   * The retrieved PASSAGE — the words the answer read, as the backend captured
   * them (`SourceEntry.chunk_text`, bounded on the wire).
   *
   * Distinct from `content`, which is a human-readable locator line, and it is
   * the field every passage surface should read: the viewer's highlight, the
   * Fundstelle rail, the "Zitierte Stelle" box, "Zitat kopieren". Deriving one
   * out of `content` is the fallback for messages persisted before this field
   * travelled — and it is only ever a locator, so it derives nothing.
   */
  snippet?: string
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
  /**
   * Where on the page the passage sits, for a passage read off a picture of the
   * page — a plan's Grundriss, a photo (issue #433). The viewer draws these
   * boxes instead of searching the page's text for `snippet`, which for such a
   * passage is the model's description of the drawing, not words on the page.
   */
  regions?: PageRegion[]
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
  /** The Punkt this passage belongs to ("3.5.2"), when the chunker established one. */
  punkt?: string | null
  /** Retrieval score (cosine similarity) the knowledge layer printed for this passage. */
  score?: number | null
  /** The retrieved passage text, bounded by the serializer. */
  snippet?: string | null
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
  /** Boxes on the page, `[{box: [x0, y0, x1, y1], label}]` normalised 0-1 (issue #433). */
  regions?: unknown
}

/**
 * The chat store: the union of its three slices, each of which declares (and
 * documents) its own state and actions. There is no second declaration here
 * to keep in step with them.
 */
export type ChatStore = MessagesSlice & SessionsSlice & InteractionSlice
