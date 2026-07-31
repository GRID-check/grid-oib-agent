/**
 * The TEXT side of a structured mention (spec MN-3).
 *
 * A mention is a structured reference — `{ targetId, display }` recorded when the
 * user picks someone out of the `@` picker — and it is never re-derived from the
 * message text. But the composer is a plain textarea: after inserting `@Anna` the
 * user can freely edit, delete or retype it. So the model needs exactly two
 * text-facing operations, and they belong here rather than scattered through the
 * composer:
 *
 * 1. **Find the fragment being typed** (`findMentionQuery`) — what opens and
 *    filters the picker — and **replace it** on insertion (`insertMention`).
 * 2. **Reconcile before sending** (`reconcileMentions`) — keep only the mentions
 *    whose `@Display` token still literally stands in the text. Deleting the text
 *    deletes the mention; nothing is ever *invented* from text that merely looks
 *    like a name (that is MN-3, and it is why matching runs against the recorded
 *    displays only, never against a directory).
 *
 * Two ambiguities are handled deliberately, because both occur in real threads:
 *
 * - **One display is a prefix of another** (`@Anna` vs `@Anna Berger`): the
 *   longest recorded display that fits at that position wins. Matching the short
 *   one first would leave " Berger" as prose and address the wrong Anna.
 * - **The same person tagged twice**: each surviving occurrence keeps its own
 *   entry (so the count in the text and the count in state agree), and
 *   `toMentionInputs` collapses them for the wire — the server addresses a person
 *   once no matter how often they were named.
 *
 * Pure and dependency-free on purpose: this is the correctness core of the
 * feature, so it is unit-tested directly rather than through the DOM.
 */

import { AGENT_MENTION_ID, type MentionInput } from '@/lib/mentions/types'

/** A mention as the composer holds it: the structured target + the text token. */
export interface DraftMention {
  targetId: string
  /** The name as inserted into the text, WITHOUT the leading `@`. */
  display: string
}

/** The `@…` fragment under the caret that the picker is filtering on. */
export interface MentionQuery {
  /** Everything after the `@`, up to the caret (never contains whitespace). */
  query: string
  /** Index of the `@` itself. */
  start: number
  /** Index just past the fragment (the caret position). */
  end: number
}

/** One piece of message text: prose, or a rendered mention token. */
export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; display: string; targetId: string }

/**
 * Upper bound on a mention fragment. A trigger that never gives up scanning
 * turns every `@` in a pasted log line into a search over the whole message.
 */
const MAX_QUERY_LENGTH = 64

/**
 * Characters that may sit immediately before an `@` and still leave it a mention.
 *
 * Whitespace alone was too strict: a user who writes `(@Anna Berger)` — brackets,
 * quotes and dashes around a name are ordinary German prose — got no picker while
 * typing and, worse, no mention at all when they sent, because the reconcile pass
 * uses this same rule. The message then went to the agent with nobody asked.
 *
 * Deliberately only OPENING marks. `-` and `/` are left out: they appear inside
 * addresses and identifiers, which is the case the boundary exists to exclude.
 */
const OPENING_MARKS = new Set(['(', '[', '{', '<', '"', "'", '„', '“', '«', '‚', '‘', '‹', '–', '—'])

/** A mention token only starts at a word boundary — never inside `a@b.com`. */
function isBoundary(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character) || OPENING_MARKS.has(character)
}

/**
 * …and only ENDS at one. Without this, a recorded `@Tom` still matched inside
 * `@Tommy`: the pill was drawn over the first four letters of somebody else's
 * name, and Tom stayed addressed by a message that no longer mentions him.
 */
function endsAtBoundary(character: string | undefined): boolean {
  return character === undefined || !/[\p{L}\p{N}_]/u.test(character)
}

/**
 * The `@` fragment the caret sits in, or `null` when the caret is not in one.
 *
 * Scanning BACKWARDS from the caret is what makes the trigger feel right: it
 * reopens on a fresh `@` however many times the user types one, it closes as soon
 * as the `@` is deleted (no fragment, no picker), and it never fires for an email
 * address, because the `@` there is not preceded by whitespace.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length))

  for (let index = position - 1; index >= 0; index -= 1) {
    if (position - index > MAX_QUERY_LENGTH + 1) return null
    const character = text[index]
    // The query is everything after `@` up to whitespace: hitting whitespace
    // first means the caret is in prose, not in a mention fragment.
    if (/\s/.test(character)) return null
    if (character !== '@') continue
    if (!isBoundary(text[index - 1])) return null
    return { query: text.slice(index + 1, position), start: index, end: position }
  }

  return null
}

/**
 * Replace the `@…` fragment with `@Display ` and report the new caret position.
 *
 * The trailing space is what closes the picker (the fragment now contains
 * whitespace) and lets the user keep typing immediately. It is skipped when the
 * text already continues with a space, so inserting mid-sentence does not leave a
 * double gap.
 */
export function insertMention(
  text: string,
  range: MentionQuery,
  display: string,
): { text: string; caret: number } {
  const rest = text.slice(range.end)
  const token = `@${display}${rest.startsWith(' ') ? '' : ' '}`
  return {
    text: `${text.slice(0, range.start)}${token}${rest}`,
    caret: range.start + token.length,
  }
}

interface Occurrence {
  start: number
  end: number
  display: string
}

/**
 * Every place a recorded display still stands as an `@` token, left to right.
 *
 * Candidates are tried longest-first so `@Anna Berger` is never mis-read as
 * `@Anna` followed by the word "Berger".
 */
function scanOccurrences(text: string, displays: readonly string[]): Occurrence[] {
  const ordered = Array.from(new Set(displays))
    .filter((display) => display.length > 0)
    .sort((left, right) => right.length - left.length)
  if (ordered.length === 0) return []

  const found: Occurrence[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] === '@' && isBoundary(text[index - 1])) {
      const match = ordered.find(
        (display) =>
          text.startsWith(display, index + 1) &&
          endsAtBoundary(text[index + 1 + display.length]),
      )
      if (match) {
        found.push({ start: index, end: index + 1 + match.length, display: match })
        index += 1 + match.length
        continue
      }
    }
    index += 1
  }
  return found
}

/**
 * Drop every mention whose token no longer stands in the text (spec MN-3).
 *
 * Returned in TEXT order — the order the reader sees — with at most as many
 * entries per display as were actually recorded, so an edited message can never
 * address more people than were picked.
 */
export function reconcileMentions(
  text: string,
  mentions: readonly DraftMention[],
): DraftMention[] {
  if (mentions.length === 0) return []

  const pool = mentions.map((mention) => ({ mention, used: false }))
  const kept: DraftMention[] = []

  for (const occurrence of scanOccurrences(text, mentions.map((mention) => mention.display))) {
    const entry = pool.find((item) => !item.used && item.mention.display === occurrence.display)
    if (!entry) continue
    entry.used = true
    kept.push({ targetId: entry.mention.targetId, display: entry.mention.display })
  }

  return kept
}

/**
 * The wire shape: one entry per addressee, in first-mentioned order. Naming
 * somebody twice is emphasis, not two requests.
 */
export function toMentionInputs(mentions: readonly DraftMention[]): MentionInput[] {
  const seen = new Set<string>()
  const inputs: MentionInput[] = []
  for (const mention of mentions) {
    if (seen.has(mention.targetId)) continue
    seen.add(mention.targetId)
    inputs.push({ targetId: mention.targetId })
  }
  return inputs
}

/** The mentions that address a person — i.e. everything but the assistant. */
export function humanMentions(mentions: readonly DraftMention[]): DraftMention[] {
  return mentions.filter((mention) => mention.targetId !== AGENT_MENTION_ID)
}

/**
 * Split message text into prose and mention tokens for rendering.
 *
 * Only the message's OWN recorded mentions can produce a token, which is what
 * keeps the renderer honest (and XSS-free — the caller builds React nodes from
 * these segments, never HTML): text that merely looks like `@Someone` renders as
 * the plain text it is.
 */
export function splitMentionSegments(
  text: string,
  mentions: readonly DraftMention[],
): MentionSegment[] {
  if (!text) return []
  if (mentions.length === 0) return [{ kind: 'text', text }]

  const targets = new Map<string, string>()
  for (const mention of mentions) {
    if (!targets.has(mention.display)) targets.set(mention.display, mention.targetId)
  }

  const segments: MentionSegment[] = []
  let cursor = 0
  for (const occurrence of scanOccurrences(text, Array.from(targets.keys()))) {
    if (occurrence.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, occurrence.start) })
    }
    segments.push({
      kind: 'mention',
      text: text.slice(occurrence.start, occurrence.end),
      display: occurrence.display,
      targetId: targets.get(occurrence.display) as string,
    })
    cursor = occurrence.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })

  return segments
}
