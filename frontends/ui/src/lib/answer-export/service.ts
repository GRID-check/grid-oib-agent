/**
 * Exporting one saved answer as a Word document.
 *
 * ## Authorization
 *
 * The export is a READ of a conversation's message, so it resolves through the
 * exact path every other answer route uses:
 * `requireResourceAccess(session, 'conversation', id, 'viewer')` — the same call
 * `listConversationMessages` makes, which checks tenancy first, then the
 * container project, then visibility and grants (ADR-0032). It is stated once,
 * here, and the route declares this function as its `enforcedBy`.
 *
 * That matters more for this endpoint than for most: it hands out a FILE. An
 * export route that resolved the message by id alone would let any signed-in
 * user walk message ids and download other organizations' answers — with their
 * citations, their project name and their building's dimensions in it — and the
 * evidence would leave in a form nothing downstream can revoke.
 */

import 'server-only'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Message } from '@/lib/db/schema'
import {
  findConversationInOrg,
  listMessagesForConversation,
} from '@/lib/conversations/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { getLocale, getTranslations } from '@/i18n/server'
import { buildAnswerDocument, type AnswerConfidence } from './answer-document'
import { DOCX_MEDIA_TYPE, renderDocx } from './docx'

export interface ExportedAnswer {
  /** File name including the extension, already header-safe. */
  filename: string
  bytes: Uint8Array
  mediaType: string
}

const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high'])
const CAPPED_REASONS = new Set(['ungrounded', 'quote_unverified'])

/**
 * Read the confidence self-assessment off the stored provenance.
 *
 * Narrowed rather than cast: `metadata.provenance` is a jsonb blob that may
 * have been written by an older build, and a confidence level that is not one
 * of the three is not a level — it is absent, and the document then carries no
 * confidence section at all rather than an unreadable one.
 */
function readConfidence(metadata: Record<string, unknown>): AnswerConfidence | null {
  const provenance = metadata.provenance
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return null
  const record = provenance as Record<string, unknown>
  const level = record.answerConfidence
  if (typeof level !== 'string' || !CONFIDENCE_LEVELS.has(level)) return null

  const reason = record.answerConfidenceReason
  const capped = record.answerConfidenceCappedReason
  return {
    level: level as AnswerConfidence['level'],
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    ...(typeof capped === 'string' && CAPPED_REASONS.has(capped)
      ? { cappedReason: capped as AnswerConfidence['cappedReason'] }
      : {}),
  }
}

/**
 * The question this answer answered: the newest human message before it.
 *
 * Read from the thread rather than from the answer's own metadata, because the
 * answer does not store it — and a question invented to fill the section would
 * be the export stating something the conversation never did. When there is no
 * preceding human message (an answer opening a thread, a replayed history) the
 * section is simply absent.
 */
function questionFor(history: Message[], answerIndex: number): string | null {
  for (let index = answerIndex - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message.role === 'user' && message.content.trim()) return message.content.trim()
  }
  return null
}

/**
 * Header-safe file name.
 *
 * The stem is transliterated to ASCII and the real name is NOT carried in an
 * RFC 5987 `filename*`, unlike the document downloads in `lib/documents`: those
 * serve a file the user named, where the original spelling is theirs to keep.
 * This one is generated, so a plain, predictable `piloti-<titel>-<datum>.docx`
 * is worth more than an umlaut — it is what an architect will type into a
 * project folder search a year later.
 */
function fileNameFor(stem: string, createdAt: Date): string {
  const day = createdAt.toISOString().slice(0, 10)
  const slug = stem
    .normalize('NFKD')
    // The umlaut expansions the decomposition above cannot make: `ö` decomposes
    // to `o` + diaeresis, which strips to `o`, but `ß` has no decomposition at
    // all and would otherwise vanish from the middle of a word.
    .replace(/ß/g, 'ss')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  return `${slug || 'piloti'}-${day}.docx`
}

/**
 * Render one stored answer as a .docx.
 *
 * Throws `NotFoundError` for a message that is not in this conversation — the
 * same answer a cross-tenant conversation gives, so neither confirms the other
 * exists (spec SH-6).
 */
export async function exportAnswerDocument(
  session: AuthorizedSession,
  conversationId: string,
  messageId: string
): Promise<ExportedAnswer> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const [conversation, history] = await Promise.all([
    findConversationInOrg(conversationId, session.organizationId),
    listMessagesForConversation(conversationId),
  ])
  if (!conversation) throw new NotFoundError()

  const index = history.findIndex((message) => message.id === messageId)
  if (index === -1) throw new NotFoundError()
  const answer = history[index]

  // A user's own message has no citations, no cards and no confidence — a
  // document built from one would be a heading over a quote. Refused with a
  // reason rather than served empty, so the caller learns it asked for the
  // wrong id instead of shipping a blank file to a client.
  if (answer.role !== 'assistant') {
    throw new UnprocessableError('Only an assistant answer can be exported as a document')
  }

  const metadata = (answer.metadata ?? {}) as Record<string, unknown>

  const project = conversation.projectId
    ? await findProjectInOrg(conversation.projectId, session.organizationId)
    : null

  const [t, locale] = await Promise.all([getTranslations('answerExport'), getLocale()])

  const blocks = buildAnswerDocument(
    {
      conversationTitle: conversation.title,
      projectName: project?.name ?? null,
      question: questionFor(history, index),
      answer: answer.content,
      // The answer's own instant. An export stamped with the download time
      // would date a year-old finding to today, which in a project file is the
      // kind of error nobody catches until it matters.
      createdAt: new Date(answer.createdAt),
      citations: metadata.citations,
      cards: metadata.cards,
      confidence: readConfidence(metadata),
    },
    t,
    locale
  )

  return {
    filename: fileNameFor(conversation.title?.trim() || t('fileName'), new Date(answer.createdAt)),
    bytes: renderDocx(blocks),
    mediaType: DOCX_MEDIA_TYPE,
  }
}
