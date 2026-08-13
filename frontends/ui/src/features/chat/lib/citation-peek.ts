/**
 * Citation → chat-peek policy.
 *
 * knowledge_search already retrieved the file. A second tool to "show it"
 * (`surface_documents`) is a chain the model will skip under loop limits, so
 * the citation itself is the signal: when a finished answer cites exactly one
 * project or Büroarchiv document, the chat opens that file beside the thread.
 *
 * Law / RIS / web citations never peek (they are not stored files). Zero or
 * two-or-more project/Büro files also stay closed — picking would be a guess.
 */

import type { ChatMessage } from '../types'
import {
  buildCitationModel,
  isCited,
  splitAnswerBody,
  type CitedDocument,
} from './citations'

/** A single stored file the chat may open from a turn's citations. */
export interface PeekableCitedFile {
  fileName: string
  source: 'projekt' | 'buero'
  title: string
}

const PEEKABLE_KINDS = new Set<CitedDocument['kind']>(['projekt', 'buero'])

/**
 * The one project/Büro document a turn cited, or null when peeking would be
 * a guess (none, or more than one).
 *
 * Counts cited documents of kind `projekt`/`buero` only — baurecht and web
 * never participate, even when they carry a filename. A cited document with
 * no filename still counts toward the "exactly one" rule so we do not open
 * a sibling that happened to have a name.
 */
export const peekableCitedFile = (docs: CitedDocument[]): PeekableCitedFile | null => {
  const files = docs.filter((doc) => PEEKABLE_KINDS.has(doc.kind) && isCited(doc))
  if (files.length !== 1) return null
  const doc = files[0]!
  const fileName = doc.fileName?.trim()
  if (!fileName) return null
  if (doc.kind !== 'projekt' && doc.kind !== 'buero') return null
  return { fileName, source: doc.kind, title: doc.title }
}

/**
 * Latest finished assistant answer in the thread, or null while that answer
 * is still streaming (citations can still grow — peeking on the first
 * project hit would reopen the wrong file when a second arrives).
 */
export const latestFinishedAssistantMessage = (
  messages: readonly ChatMessage[] | undefined,
): ChatMessage | null => {
  if (!messages?.length) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (!isAssistantAnswer(message)) continue
    if (message.isStreaming) return null
    return message
  }
  return null
}

/**
 * Build the turn's citation model the same way the answer surface does, then
 * apply {@link peekableCitedFile}. Cards and the written Quellen list are
 * folded in so a filename that only survived in prose still resolves.
 */
export const peekableFileForMessage = (message: ChatMessage): PeekableCitedFile | null => {
  const { entries } = splitAnswerBody(message.content ?? '')
  return peekableCitedFile(
    buildCitationModel({
      citations: message.citations,
      entries,
      cards: message.cards,
    }),
  )
}

const isAssistantAnswer = (message: ChatMessage): boolean =>
  message.messageType === 'agent_response' ||
  (message.role === 'assistant' && (message.messageType === undefined || message.messageType === 'assistant'))
