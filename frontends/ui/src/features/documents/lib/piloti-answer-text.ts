/**
 * Piloti's canvas answer as text: as the card shows it, and as a thread or a
 * mark keeps it. Shared by the answer card and the thread's unposted answer.
 */

import { MAX_ANNOTATION_BODY } from '@/lib/annotations/types'
import { stripDirectives } from '@/lib/text/answer-directives'

/** A card's place in the answer (`[[card:N]]`): the canvas draws no cards, the chat does. */
const CARD_MARKER = /[ \t]*\[\[card:[0-9]+\]\][ \t]*\n?/g

/** The answer as the card shows it. */
export const answerMarkdown = (text: string): string => text.replace(CARD_MARKER, '').trim()

/**
 * Markdown's inline marks taken off, for a thread, which shows plain text: the
 * words stay, the asterisks, hashes and link targets go. Lists, tables and
 * line breaks stay as written; they read as text.
 */
const unmarked = (markdown: string): string =>
  markdown
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')

/** The answer as an Anmerkung's body: plain, and within the column's bound. */
export function answerAsBody(text: string): string {
  const plain = unmarked(stripDirectives(answerMarkdown(text))).trim()
  return plain.length <= MAX_ANNOTATION_BODY ? plain : `${plain.slice(0, MAX_ANNOTATION_BODY - 1).trimEnd()}…`
}
