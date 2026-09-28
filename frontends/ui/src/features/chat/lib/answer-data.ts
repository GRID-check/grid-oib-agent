/**
 * What an answer's designed blocks read from the turn's own record rather than
 * from the model's text (`AnswerDataProvider`): where the turn searched, and
 * whether the masthead says the question is not regulated.
 */

import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { SearchedSource } from '@/shared/components/MarkdownRenderer/answer-block-context'

/**
 * The documents the turn searched, once each, in the order it first reached
 * them: „Gesucht in" of a `:::not-found`. Read off the retrieval ledger, the
 * backend's account of the rounds, so the pane can never claim a search the
 * turn did not run.
 */
export function searchedSources(ledger: RetrievalLedger | undefined): SearchedSource[] {
  const seen = new Map<string, SearchedSource>()
  for (const round of ledger ?? []) {
    for (const doc of round.docs) {
      const key = doc.name.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.set(key, { title: doc.title ?? doc.name, ...(doc.detail ? { detail: doc.detail } : {}) })
    }
  }
  return [...seen.values()]
}

const NOT_REGULATED = /\b(?:nicht|kaum|teilweise)\s+geregelt\b|\bkeine\s+regelung\b|\bnot\s+regulated\b|\bno\s+rule\b/i

/**
 * Whether the masthead's verdict says the question is (partly) not regulated,
 * the only answer a `:::not-found` is drawn in. Undefined for an answer with no
 * envelope, where nothing says either way.
 */
export function isNotRegulated(answerMeta: AnswerMeta | undefined): boolean | undefined {
  if (!answerMeta) return undefined
  const words = [answerMeta.verdict?.value, answerMeta.topic].filter(Boolean).join(' ')
  return NOT_REGULATED.test(words)
}
