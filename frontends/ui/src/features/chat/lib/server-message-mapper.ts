/**
 * Server Message Mapper
 *
 * Maps server-persisted conversation messages (BFF `messages` rows) back into
 * the client `ChatMessage` shape so past chats can repopulate when
 * localStorage no longer has them (quota cleanup, new device, cleared site
 * data). The server stores a deliberately small payload — role, content,
 * timestamps plus a metadata jsonb (messageType, errorData, fileData, cards,
 * cardInteractions, enabledDataSources, messageFiles, citations) — so heavy
 * stream state (thinking steps, report content) is not restored here; it is
 * refetched on demand like the localStorage pruning path already does.
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
import type { ChatMessage, ErrorCardData, FileCardData, MessageType } from '../types'
import type { GridCard } from '@/shared/cards/schemas'
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
    ...(Array.isArray(metadata.cards) ? { cards: metadata.cards as GridCard[] } : {}),
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
  }
}

/** Map a full server history, dropping rows the chat window can't render. */
export const mapServerMessagesToChatMessages = (messages: Message[]): ChatMessage[] =>
  messages
    .map(mapServerMessageToChatMessage)
    .filter((message): message is ChatMessage => message !== null)
