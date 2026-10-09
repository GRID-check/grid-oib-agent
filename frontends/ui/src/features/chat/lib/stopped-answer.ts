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

/** A citation marker the settle has not resolved yet: the streamed `[N]`. */
const PENDING_MARKER = /\s*\[\d+\]/g
/** A card's place, with its number. */
const NUMBERED_CARD_MARKER = /\s*\[\[card:(\d+)\]\]/g
/** A marker the cut left open at the very end (`[1`, `[[card:`): half a marker means nothing. */
const OPEN_MARKER_TAIL = /\s*\[\[?[^[\]\s]*$/

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
  const sources = resolved && text.trim() ? stretch.sources : []
  const cards = placedCards(stretch.cards, text)
  text = text.replace(NUMBERED_CARD_MARKER, (marker, number: string) => (Number(number) <= cards.length ? marker : ''))
  return { text: text.trim(), sources, cards }
}
