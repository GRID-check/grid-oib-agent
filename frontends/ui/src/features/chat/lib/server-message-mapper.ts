/**
 * Server Message Mapper
 *
 * Maps server-persisted conversation messages (BFF `messages` rows) back into
 * the client `ChatMessage` shape so past chats can repopulate when
 * localStorage no longer has them (quota cleanup, new device, cleared site
 * data). The server stores a deliberately small payload — role, content,
 * timestamps plus a metadata jsonb (messageType, errorData, fileData, cards,
 * cardInteractions, enabledDataSources, messageFiles, citations, provenance) —
 * so the heaviest stream state (a deep-research report's body) is not restored
 * here; it is refetched on demand like the localStorage pruning path already does.
 *
 * The **provenance** IS restored (ADR-0037): the Herleitung in its compact form,
 * the confidence self-assessment, the routing transparency and the deep-research
 * job pointer. Without it a shared thread showed a colleague a bare answer — they
 * hold no agent socket by design (ADR-0033 §7), so the intermediate frames never
 * reach them and this row is the only place the reasoning could come from. It also
 * fixes the same loss for the ASKER on a second device, which predates sharing.
 *
 * Citations ARE restored, and are not optional in the way the rest of that
 * payload is: an answer that comes back without its provenance is an answer
 * making an ungrounded claim, which is the one thing this product must never
 * render. They are decoded through the same versioned contract the write path
 * encodes with — see `lib/citations/persistence`.
 *
 * Authorship (`authorUserId`) and the collaboration metadata (`mentions`,
 * `addressees`) ride along too, because for a SHARED thread this mapper is not a
 * fallback but the PRIMARY load path (ADR-0033): the rows it maps are the truth,
 * and a message whose author it drops cannot be attributed to the colleague who
 * wrote it. The display *name* and avatar are deliberately not mapped — they are
 * not on the message row; the shared-thread hook resolves them from the
 * conversation's roster, so a renamed colleague is renamed everywhere at once.
 */

import type { Message } from '@/lib/db/schema'
import { CAPPED_REASONS } from '@/lib/conversations/message-provenance'

import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'
import type { ChatMessage, ErrorCardData, FileCardData, MessageType, ThinkingStep } from '../types'
import { validateGridCards } from '@/shared/cards/schemas'
import { sanitizeCardInteractions } from '@/features/grid-cards/card-decision'
import { decodeCitations } from './citations'

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'status',
  'prompt',
  'agent_response',
  'file',
  'error',
  'deep_research_banner',
])

const asMessageType = (value: unknown): MessageType | undefined =>
  typeof value === 'string' && MESSAGE_TYPES.has(value) ? (value as MessageType) : undefined

/**
 * Structured mentions carried on the row (spec MN-3), narrowed rather than cast:
 * this jsonb is read back by a build that may not be the one that wrote it, and a
 * malformed entry must not reach a renderer that indexes into it.
 */
const asMentions = (value: unknown): ChatMessage['mentions'] | undefined => {
  if (!Array.isArray(value)) return undefined
  const mentions = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const { targetId, display } = entry as { targetId?: unknown; display?: unknown }
    if (typeof targetId !== 'string' || targetId.length === 0) return []
    return [{ targetId, display: typeof display === 'string' ? display : targetId }]
  })
  return mentions.length > 0 ? mentions : undefined
}

/**
 * The server's addressee ruling, stored on the message at persist time (spec
 * MN-2). Read for RENDERING only — the decision it drove (whether to open an
 * agent turn) was made when the message was written and is never re-derived here.
 */
const asAddressees = (value: unknown): ChatMessage['addressees'] | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const { agent, users } = value as { agent?: unknown; users?: unknown }
  if (typeof agent !== 'boolean' || !Array.isArray(users)) return undefined
  return { agent, users: users.filter((user): user is string => typeof user === 'string') }
}

/**
 * Map one server message row to a ChatMessage.
 *
 * Returns null for roles the chat window never renders (system/tool) so a
 * future backend writer can't inject blank bubbles into restored history.
 */
export const mapServerMessageToChatMessage = (message: Message): ChatMessage | null => {
  if (message.role !== 'user' && message.role !== 'assistant') return null

  const metadata = (message.metadata ?? {}) as Record<string, unknown>

  const messageType =
    asMessageType(metadata.messageType) ?? (message.role === 'user' ? 'user' : 'agent_response')
  // Over JSON the timestamp arrives as an ISO string despite the Date type.
  const timestamp = new Date(message.createdAt as unknown as string)
  // The message's own time, not the clock: a citation restored from history was
  // captured when the answer was written, not when the page was reopened.
  const citations = decodeCitations(metadata.citations, timestamp)

  return {
    id: String(message.id),
    role: message.role,
    content: message.content,
    timestamp,
    messageType,
    // WHICH person wrote this (spec CC-3). Carried through unconditionally, so a
    // colleague's message arrives attributable in a shared thread — the server
    // has already attributed legacy rows to the conversation's creator (MG-3),
    // and NULL on an assistant row is correct and stays null.
    ...(message.authorUserId ? { authorUserId: message.authorUserId } : {}),
    ...(() => {
      const mentions = asMentions(metadata.mentions)
      return mentions ? { mentions } : {}
    })(),
    ...(() => {
      const addressees = asAddressees(metadata.addressees)
      return addressees ? { addressees } : {}
    })(),
    ...(citations ? { citations } : {}),
    ...(metadata.errorData ? { errorData: metadata.errorData as ErrorCardData } : {}),
    ...(metadata.fileData ? { fileData: metadata.fileData as FileCardData } : {}),
    // Validated, not cast. The live websocket path runs `validateGridCards`;
    // this one — every card read back out of the database — did not, so a
    // single row written under a different schema version reached a renderer
    // that indexes a lookup table by an unvalidated field, threw during
    // render, and blanked the WHOLE conversation rather than that one card.
    ...(Array.isArray(metadata.cards) ? { cards: validateGridCards(metadata.cards) } : {}),
    // Restored WITH their answers: a card whose patch was already applied must
    // not come back offering the button again (see card-decision.ts). Narrowed
    // rather than cast — this jsonb blob is the only card state not written by
    // the current build.
    ...(() => {
      const interactions = sanitizeCardInteractions(metadata.cardInteractions)
      return interactions ? { cardInteractions: interactions } : {}
    })(),
    ...(Array.isArray(metadata.enabledDataSources)
      ? { enabledDataSources: metadata.enabledDataSources as string[] }
      : {}),
    ...(Array.isArray(metadata.messageFiles)
      ? { messageFiles: metadata.messageFiles as Array<{ id: string; fileName: string }> }
      : {}),
    // What the answer rested on. Spread last so a future metadata key cannot
    // silently shadow one of the fields above.
    ...restoreProvenance(metadata.provenance),
    ...restorePrompt(metadata.prompt, metadata.promptState),
  }
}

/**
 * Rebuild a human-in-the-loop prompt and its answer (ADR-0037).
 *
 * `promptFor` is the person the agent asked, and it is what lets every other reader
 * be shown the question read-only: the agent tier refuses an answer from anybody
 * else (`_may_answer_interaction`), so offering them the buttons would be offering a
 * refusal.
 *
 * `isPromptResponded` is derived from the stored answer rather than stored
 * separately — two fields that can disagree about the same fact is one field too
 * many.
 */
const restorePrompt = (prompt: unknown, promptState: unknown): Partial<ChatMessage> => {
  const out: Partial<ChatMessage> = {}

  if (typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt)) {
    const detail = prompt as Record<string, unknown>
    if (isPromptType(detail.promptType)) out.promptType = detail.promptType
    if (typeof detail.promptId === 'string') out.promptId = detail.promptId
    if (typeof detail.promptParentId === 'string') out.promptParentId = detail.promptParentId
    if (typeof detail.promptInputType === 'string') {
      out.promptInputType = detail.promptInputType as ChatMessage['promptInputType']
    }
    if (Array.isArray(detail.promptOptions)) {
      out.promptOptions = detail.promptOptions.filter(
        (option): option is string => typeof option === 'string',
      )
    }
    if (typeof detail.promptPlaceholder === 'string') {
      out.promptPlaceholder = detail.promptPlaceholder
    }
    if (typeof detail.promptFor === 'string') out.promptFor = detail.promptFor
  }

  if (typeof promptState === 'object' && promptState !== null && !Array.isArray(promptState)) {
    const answer = (promptState as { response?: unknown }).response
    // Non-empty, matching what `sanitizePromptState` will store: `''` would render
    // as "responded" with nothing to show, which is worse than still asking. The
    // read has to agree with the write, or a row from another build renders wrong.
    if (typeof answer === 'string' && answer.length > 0) {
      out.promptResponse = answer
      out.isPromptResponded = true
    }
  }

  return out
}

const PROMPT_TYPES = ['clarification', 'approval', 'choice', 'text-input', 'plan_approval'] as const
const isPromptType = (value: unknown): value is ChatMessage['promptType'] =>
  typeof value === 'string' && (PROMPT_TYPES as readonly string[]).includes(value)

/**
 * Unpack the stored provenance onto the message shape the renderers already read.
 *
 * Flattened rather than nested under a `provenance` key, because `ChatThinking`,
 * the confidence chip and the routing line each take their own prop and none of
 * them should have to know that this arrived from a server row rather than from a
 * live stream. Timestamps are revived to `Date`, which is what the step shape
 * declares and what the renderer sorts on.
 *
 * Narrowed, not cast: the server bounds this on write (`sanitizeProvenance`), but
 * a row written by an older build is still whatever it was.
 */
const restoreProvenance = (value: unknown): Partial<ChatMessage> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const provenance = value as Record<string, unknown>
  const out: Partial<ChatMessage> = {}

  if (Array.isArray(provenance.thinkingSteps)) {
    const steps = provenance.thinkingSteps
      .filter((step): step is Record<string, unknown> => typeof step === 'object' && step !== null)
      .map((step) => ({
        ...(step as unknown as ThinkingStep),
        timestamp: new Date(step.timestamp as string),
        // The payload was dropped on write, exactly as the localStorage prune
        // drops it; the renderer reads `displayName` and `traceLanes`.
        content: '',
      }))
    if (steps.length > 0) out.thinkingSteps = steps
  }

  if (isConfidence(provenance.answerConfidence)) out.answerConfidence = provenance.answerConfidence
  if (typeof provenance.answerConfidenceReason === 'string') {
    out.answerConfidenceReason = provenance.answerConfidenceReason
  }
  if (isCappedReason(provenance.answerConfidenceCappedReason)) {
    out.answerConfidenceCappedReason = provenance.answerConfidenceCappedReason
  }
  if (isRoutingDecision(provenance.routingDecision)) {
    out.routingDecision = provenance.routingDecision
  }
  if (typeof provenance.routingReason === 'string') out.routingReason = provenance.routingReason
  if (typeof provenance.escalationReason === 'string') {
    out.escalationReason = provenance.escalationReason
  }
  if (
    typeof provenance.citationsRemoved === 'object' &&
    provenance.citationsRemoved !== null &&
    typeof (provenance.citationsRemoved as { count?: unknown }).count === 'number'
  ) {
    out.citationsRemoved = provenance.citationsRemoved as { count: number; reasons: string[] }
  }
  if (provenance.researchTruncated === true) {
    out.researchTruncated = true
  }
  if (typeof provenance.deepResearchJobId === 'string') {
    out.deepResearchJobId = provenance.deepResearchJobId
  }
  if (provenance.showViewReport === true) out.showViewReport = true

  return out
}

const isConfidence = (value: unknown): value is 'low' | 'medium' | 'high' =>
  value === 'low' || value === 'medium' || value === 'high'

const isRoutingDecision = (value: unknown): value is 'meta' | 'shallow' | 'deep' | 'error' =>
  value === 'meta' || value === 'shallow' || value === 'deep' || value === 'error'

/**
 * The five causes the overconfidence guard can report. An allowlist rather than
 * a cast because this reads a persisted jsonb column: an older row, or a newer
 * server, can carry anything, and a value the chip has no copy for would render
 * a cap with no explanation.
 */
const isCappedReason = (value: unknown): value is AnswerConfidenceCappedReason =>
  CAPPED_REASONS.includes(value as AnswerConfidenceCappedReason)

/** Map a full server history, dropping rows the chat window can't render. */
export const mapServerMessagesToChatMessages = (messages: Message[]): ChatMessage[] =>
  messages
    .map(mapServerMessageToChatMessage)
    .filter((message): message is ChatMessage => message !== null)
