/**
 * What a stopped answer keeps (`docs/design/chat-wire-v2.md` §c, Stop).
 *
 * Three writers store a stopped answer under the same message id: the agent
 * tier (`TurnTextFold.stopped`, `src/aiq_agent/turn/streaming.py`), the
 * asker's client (`stopTurnView` in `turn-fold.ts`) and the BFF, which cuts a
 * row the server stored whole because the Stop reached it after the answer
 * had finished (`cutStoppedAnswer` in `lib/conversations/service.ts`).
 * Whichever write lands, a reload must show the same bytes, so this is the one
 * TypeScript copy of the rule, and `shared/wire/v2/stopped-cases.jsonl` holds
 * it and the Python one to the same cases (`stopped-answer.spec.ts`,
 * `tests/aiq_agent/turn/test_streaming.py`).
 *
 * The rule: the first `chars` code points of the stretch the reader was
 * reading, a marker the cut left half written dropped. A settled text (the
 * cut is a prefix of the snapshot the stretch began with) keeps its `[N]` and
 * its sources; a streamed one drops its pending `[N]`, whose sources never
 * arrived. The cards kept are the leading run that had arrived and whose
 * `[[card:N]]` is in the kept text: `N` is a position in the list, so a gap
 * ends what can be kept, and a place whose card is not kept is dropped.
 * Pure, and free of anything browser- or server-only: both sides import it.
 */

/*
 * Every class below is ASCII and spelled out: whitespace is ` \t\n\r\f\v`,
 * a digit is `0-9`. Python's `\s`, `\d` and `str.strip` are Unicode-wide and
 * JavaScript's differ from them (Python strips U+0085 and U+001C, `trim`
 * strips U+FEFF; Python's `\d` matches a full-width digit), and any difference
 * is a reload that shows other bytes than the reader stopped on.
 * `streaming.py` spells the same classes, and `stopped-cases.jsonl` holds a
 * case for each of those characters.
 */

/** A citation marker the settle has not resolved yet: the streamed `[N]`. */
const PENDING_MARKER = /[ \t\n\r\f\v]*\[[0-9]+\]/g
/** A card's place, with its number. */
const NUMBERED_CARD_MARKER = /[ \t\n\r\f\v]*\[\[card:([0-9]+)\]\]/g
/**
 * A marker the cut left open at the very end (`[1`, `[[card:`, `[[card:1]`):
 * half a marker means nothing. The last one holds a `]`, which the first
 * alternative stops at, and a cut between a card marker's two brackets ends there.
 */
const OPEN_MARKER_TAIL = /[ \t\n\r\f\v]*(?:\[\[?[^[\] \t\n\r\f\v]*|\[\[card:[0-9]+\])$/
/** The rule's whitespace at either end of a text: what `trim` takes, without its Unicode extras. */
const EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g

/** `text` without the rule's whitespace at either end (`str.strip` with the same set, in Python). */
export const trimStopped = (text: string): string => text.replace(EDGE_WHITESPACE, '')

/** The answer as the reader had it: the text so far and what had arrived beside it. */
export interface AnswerStretch<Card, Source> {
  text: string
  /** The snapshot's text this stretch began with, whose `[N]` resolve to `sources`; absent for streamed prose. */
  settled?: string | null
  sources: Source[]
  /** By index: a card, `null` refused, `undefined` not arrived. */
  cards: readonly (Card | null | undefined)[]
}

export interface StoppedAnswer<Card, Source> {
  text: string
  /** `stretch.sources` itself when kept, so a caller comparing by identity sees no change. */
  sources: Source[]
  cards: Card[]
}

/** How many leading code points `a` and `b` share: where a text on screen and a stored one part. */
export const sharedPrefixChars = (a: string, b: string): number => {
  const left = Array.from(a)
  const right = Array.from(b)
  let shared = 0
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1
  return shared
}

/** `text` with every marker the rule may drop taken out, and the rule's whitespace off its ends. */
const withoutMarkers = (text: string): string =>
  trimStopped(text.replace(PENDING_MARKER, '').replace(NUMBERED_CARD_MARKER, ''))

/**
 * Whether `stored` holds nothing the reader did not have in `shown`: once the
 * markers a cut may drop are out of both, it is `shown` or a prefix of it. A
 * row any of the three writers already cut passes, so cutting it again is
 * skipped rather than cutting it at the first marker the earlier cut dropped;
 * a row holding more than the reader saw does not, whatever its metadata says.
 */
export const holdsNoMoreThan = (stored: string, shown: string): boolean =>
  withoutMarkers(shown).startsWith(withoutMarkers(stored))

const placedCards = <Card>(cards: readonly (Card | null | undefined)[], text: string): Card[] => {
  const placed = new Set(Array.from(text.matchAll(NUMBERED_CARD_MARKER), (match) => Number(match[1])))
  const kept: Card[] = []
  for (const [index, card] of cards.entries()) {
    if (card === null || card === undefined || !placed.has(index + 1)) break
    kept.push(card)
  }
  return kept
}

/** The answer a reader who saw the first `chars` code points of `stretch` keeps. */
export const stoppedAnswer = <Card, Source>(
  stretch: AnswerStretch<Card, Source>,
  chars: number
): StoppedAnswer<Card, Source> => {
  const all = Array.from(stretch.text)
  let text = all.slice(0, chars).join('')
  if (chars < all.length) text = text.replace(OPEN_MARKER_TAIL, '')
  const resolved = typeof stretch.settled === 'string' && stretch.settled.startsWith(text)
  if (!resolved) text = text.replace(PENDING_MARKER, '')
  const sources = resolved && trimStopped(text) ? stretch.sources : []
  const cards = placedCards(stretch.cards, text)
  text = text.replace(NUMBERED_CARD_MARKER, (marker, number: string) => (Number(number) <= cards.length ? marker : ''))
  return { text: trimStopped(text), sources, cards }
}
