/**
 * Server Message Mapper
 *
 * Maps server-persisted conversation messages (BFF `messages` rows) back into
 * the client `ChatMessage` shape so past chats can repopulate when
 * localStorage no longer has them (quota cleanup, new device, cleared site
 * data). The server stores a deliberately small payload — role, content,
 * timestamps plus a metadata jsonb (messageType, errorData, fileData, cards,
 * enabledDataSources, messageFiles) — so heavy stream state (thinking steps,
 * report content) is not restored here; it is refetched on demand like the
 * localStorage pruning path already does.
 */

import type { Message } from '@/lib/db/schema'
import type { ChatMessage, ErrorCardData, FileCardData, MessageType } from '../types'
import type { GridCard } from '@/shared/cards/schemas'

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

  return {
    id: String(message.id),
    role: message.role,
    content: message.content,
    // Over JSON the timestamp arrives as an ISO string despite the Date type.
    timestamp: new Date(message.createdAt as unknown as string),
    messageType,
    ...(metadata.errorData ? { errorData: metadata.errorData as ErrorCardData } : {}),
    ...(metadata.fileData ? { fileData: metadata.fileData as FileCardData } : {}),
    ...(Array.isArray(metadata.cards) ? { cards: metadata.cards as GridCard[] } : {}),
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
