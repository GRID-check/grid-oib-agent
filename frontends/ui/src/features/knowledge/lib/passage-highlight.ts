/**
 * Locating a cited passage inside a rendered PDF page.
 *
 * A citation tells us a page and the retrieved passage TEXT — there is no
 * geometry anywhere in the pipeline (the backend `SourceRegistry` keys on
 * `(collection, filename, page)` and carries a snippet string, nothing more).
 * So the rectangles to light up have to be recovered on the client, by matching
 * that snippet against the page's own text layer.
 *
 * The matching cannot be an `indexOf`. The snippet was produced by a different
 * extractor than pdf.js's text layer, so by the time the same sentence reaches
 * both sides it differs in ways that are invisible to a reader and fatal to a
 * substring search: line-wrap hyphenation (`Ver-\nwaltung`), ligatures (`ﬁ`),
 * typographic quotes and dashes, soft hyphens, punctuation one side kept and
 * the other dropped, collapsed or inserted whitespace where the PDF split a
 * line into a dozen positioned runs, and chunk boundaries that cut mid-word.
 * Each of those is handled below by normalising BOTH sides into one comparable
 * stream — letters, digits and single spaces, nothing else — while keeping, for
 * every surviving character, which text run it came from and where in that run,
 * which is what turns a match back into pixels.
 *
 * Four matchers run in order of decreasing confidence, because a wrong
 * highlight is worse than none: exact substring, then anchoring on the first
 * and last few words (the middle of a snippet is where extractors disagree
 * most), then a word-overlap window with a score floor, then the two halves of
 * the snippet on their own — for a passage that straddles a page break, or one
 * whose window tied and withdrew. Below all four we return nothing and the
 * viewer just opens at the page.
 */

/**
 * A positioned run of text on one page, in unscaled PDF viewport space with a
 * TOP-LEFT origin — the same space `HighlightRect` comes back in, so the caller
 * scales both by the zoom factor and nothing here needs to know about zoom.
 */
export interface TextChunk {
  text: string
  x: number
  /** Top edge (not the PDF baseline — the caller converts). */
  y: number
  width: number
  height: number
}

export interface HighlightRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Which matcher found the passage. The viewer shows the fuzzy tier differently
 * — a reader who is verifying a citation needs to know whether the highlight is
 * the passage or the software's best guess at it.
 */
export type PassageMatcher = 'exact' | 'anchored' | 'windowed' | 'partial'

export interface PassageMatch {
  rects: HighlightRect[]
  matcher: PassageMatcher
  /** Share of the snippet's distinctive words covered; 1 for the certain tiers. */
  score: number
}

/**
 * One normalised character plus where it came from. `chunk`/`offset` are -1 for
 * the synthetic spaces inserted between runs, which belong to no run and so can
 * never contribute to a rectangle.
 */
interface IndexedChar {
  ch: string
  chunk: number
  offset: number
}

export interface PassageIndex {
  chunks: TextChunk[]
  /** The normalised page text, one character per `chars` entry. */
  haystack: string
  chars: IndexedChar[]
}

/**
 * Word-overlap fraction a windowed match must reach to be shown. Two thirds is
 * deliberately strict: at half, a passage of common German connectives matches
 * almost any paragraph on the page, and the reader is pointed at the wrong one
 * with the same confidence as a real hit.
 */
export const MIN_WINDOW_SCORE = 0.66

/** Words shorter than this carry no signal for window scoring. */
const MIN_SCORING_WORD = 4

/**
 * Characters of a word the window matcher compares.
 *
 * German inflects at the end — `Sachverständige`/`Sachverständiger`,
 * `bestehende`/`bestehenden`, `Dachstuhls`/`Dachstuhles` — and two extractors
 * quoting the same clause routinely land on different endings. Comparing whole
 * words scores those four pairs as four misses and sinks a passage that is
 * plainly the right one; comparing stems scores them as matches. Six characters
 * is long enough to keep `Verfahren` and `Verfassung` apart, which is the risk
 * on the other side.
 */
const STEM_LENGTH = 6

/** Words taken from each end of the snippet when anchoring. */
const ANCHOR_WORDS = [8, 6, 4, 3]

/**
 * Shortest half the partial matcher will look for on its own. Below this a
 * half is a clause every page has a copy of, and the snippet as a whole must
 * be at least two of them — so a short snippet never goes partial at all.
 */
export const MIN_PARTIAL_HALF = 24

/**
 * Characters `foldChar`'s generic rule would get wrong.
 *
 * The dashes fold to a plain hyphen so a word wrapped with a typographic dash
 * still reads as one wrapped word. The invisible characters fold to NOTHING
 * rather than to a boundary: a soft hyphen or a zero-width space sits INSIDE a
 * word, so making it a space would split a hyphenated compound in two \u2014 the
 * exact failure the folding exists to prevent. Quotes and every other mark are
 * left to the generic rule, which turns them into boundaries.
 */
const CHARACTER_FOLDING: Record<string, string> = {
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u00A0': ' ',
  '\u2007': ' ',
  '\u2009': ' ',
  '\u202F': ' ',
  '\u200B': '',
  '\u00AD': '',
  '\uFEFF': '',
}

const isWhitespace = (ch: string): boolean => /\s/.test(ch)
const isLetter = (ch: string): boolean => /\p{L}/u.test(ch)

/**
 * Fold one source character into zero or more comparable ones. The compatibility
 * decomposition is what turns the `ﬁ` ligature into `fi` — without it a snippet
 * spelling the two letters out never matches the run that carries the single
 * glyph.
 *
 * Everything that is not a letter, a digit or whitespace becomes a SPACE, i.e.
 * a word boundary rather than a character to agree about. Punctuation is where
 * two extractors disagree most cheaply — a trailing comma the retriever kept
 * and the text layer dropped is enough to make `erstattet,` and `erstattet`
 * different words — and none of it identifies a passage. The hyphen is the one
 * exception: it survives folding so `collapse` can tell a wrapped word from a
 * compound, and is turned into a boundary there once that decision is made.
 */
const foldChar = (raw: string): string => {
  const folded = CHARACTER_FOLDING[raw]
  if (folded !== undefined) return folded
  // NFKD, not NFKC. Folding happens one SOURCE character at a time, so a
  // composing form can never see the base letter and its combining mark
  // together — and the two are handed to us by different producers: a
  // precomposed `ü` (U+00FC) would survive as `ü` while a decomposed
  // `u` + U+0308 would lose its mark and become `u`, so the same word folds two
  // ways and no matcher tier can recover it. Decomposing instead sends both to
  // `u`. It still expands the `ﬁ` ligature, which is a COMPATIBILITY
  // decomposition and therefore present in NFKD too.
  const normalized = raw.normalize('NFKD').toLowerCase()
  // A combining accent left over from decomposition is not a character the
  // reader typed, and dropping it lets `ﬀ`-style expansions stay aligned.
  return normalized.replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ')
}

/**
 * Collapse the raw folded stream into letters, digits and single spaces, and
 * resolve every surviving hyphen.
 *
 * A hyphen means one of two things and they need opposite treatment. Written
 * `letter + '-' + line break + letter` it is not part of the word at all — the
 * typesetter put it there to wrap `Verwaltung`, and the word only matches a
 * snippet once the hyphen AND the break are gone. Anywhere else (`Bau-Recht`,
 * `3 - 5`) it is ordinary punctuation, so it becomes a boundary like every
 * other mark. Getting these two the same way round is the difference between
 * finding a wrapped word and inventing one.
 */
const collapse = (raw: IndexedChar[]): IndexedChar[] => {
  const out: IndexedChar[] = []
  const pushBoundary = (): void => {
    const previous = out[out.length - 1]
    if (!previous || previous.ch === ' ') return
    out.push({ ch: ' ', chunk: -1, offset: -1 })
  }

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i]!
    if (entry.ch === '-') {
      // Look past the break for the next character that carries any meaning.
      let j = i + 1
      while (j < raw.length && isWhitespace(raw[j]!.ch)) j += 1
      const broke = j > i + 1
      const previous = out[out.length - 1]
      if (broke && previous && isLetter(previous.ch) && j < raw.length && isLetter(raw[j]!.ch)) {
        // Wrapped word: swallow the hyphen and the break, welding the halves.
        i = j - 1
        continue
      }
      pushBoundary()
      continue
    }
    if (isWhitespace(entry.ch)) {
      pushBoundary()
      continue
    }
    out.push(entry)
  }
  while (out.length && out[out.length - 1]!.ch === ' ') out.pop()
  return out
}

/**
 * Build the searchable stream for one page.
 *
 * A synthetic space goes between runs that do not already end or begin with
 * whitespace: pdf.js emits a positioned run per style change, so a single
 * printed line arrives as several items and concatenating them raw would weld
 * the last word of one to the first of the next.
 */
export function buildPassageIndex(chunks: TextChunk[]): PassageIndex {
  const raw: IndexedChar[] = []
  chunks.forEach((chunk, chunkIndex) => {
    if (chunkIndex > 0) raw.push({ ch: ' ', chunk: -1, offset: -1 })
    for (let offset = 0; offset < chunk.text.length; offset += 1) {
      const folded = foldChar(chunk.text[offset]!)
      for (const ch of folded) raw.push({ ch, chunk: chunkIndex, offset })
    }
  })
  const chars = collapse(raw)
  return { chunks, chars, haystack: chars.map((entry) => entry.ch).join('') }
}

/** Normalise a snippet with exactly the rules the index was built with. */
export function normalizePassage(text: string): string {
  const raw: IndexedChar[] = []
  for (let offset = 0; offset < text.length; offset += 1) {
    for (const ch of foldChar(text[offset]!)) raw.push({ ch, chunk: 0, offset })
  }
  return collapse(raw)
    .map((entry) => entry.ch)
    .join('')
}

interface Word {
  text: string
  start: number
  end: number
}

/** Split a normalised string into words carrying their character spans. */
const words = (text: string): Word[] => {
  const out: Word[] = []
  const pattern = /[^\s]+/g
  let match = pattern.exec(text)
  while (match) {
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length })
    match = pattern.exec(text)
  }
  return out
}

interface Range {
  start: number
  end: number
}

/**
 * Anchor on the ends of the snippet. Extractors disagree most in the middle of
 * a passage (a table cell, a footnote marker, a hyphenated compound spliced
 * differently), while the opening and closing words usually survive intact —
 * so matching both ends and taking everything between them recovers passages
 * that no substring search would find.
 */
const anchorMatch = (haystack: string, needle: string): Range | null => {
  const needleWords = words(needle)
  if (needleWords.length < 3) return null

  const findFrom = (count: number, fromEnd: boolean): number => {
    if (needleWords.length < count) return -1
    const slice = fromEnd ? needleWords.slice(-count) : needleWords.slice(0, count)
    const phrase = needle.slice(slice[0]!.start, slice[slice.length - 1]!.end)
    const first = haystack.indexOf(phrase)
    if (first === -1) return -1
    // A phrase occurring twice on the page is not an anchor — it points at two
    // places at once, and picking one silently is how you highlight the wrong
    // paragraph with full confidence.
    if (haystack.indexOf(phrase, first + 1) !== -1) return -1
    return fromEnd ? first + phrase.length : first
  }

  let start = -1
  let end = -1
  for (const count of ANCHOR_WORDS) {
    if (start === -1) start = findFrom(count, false)
    if (end === -1) end = findFrom(count, true)
    if (start !== -1 && end !== -1) break
  }

  if (start !== -1 && end !== -1 && end > start) {
    const span = end - start
    // The span between two real anchors is within a factor of the snippet's own
    // length. Wildly outside that and the two anchors belong to different
    // passages that happen to share their edges.
    if (span >= needle.length * 0.5 && span <= needle.length * 2.5) return { start, end }
  }
  if (start !== -1) return { start, end: Math.min(haystack.length, start + needle.length) }
  if (end !== -1) return { start: Math.max(0, end - needle.length), end }
  return null
}

/**
 * Last resort: slide a window the size of the snippet across the page and keep
 * the one sharing the most distinctive words. Survives a passage that was
 * re-flowed or partially re-worded, and is the only matcher gated by a score.
 */
const windowMatch = (haystack: string, needle: string): { range: Range; score: number } | null => {
  const needleWords = words(needle).filter((word) => word.text.length >= MIN_SCORING_WORD)
  if (needleWords.length < 3) return null

  const stem = (word: string): string => word.slice(0, STEM_LENGTH)

  const wanted = new Map<string, number>()
  for (const word of needleWords) {
    const key = stem(word.text)
    wanted.set(key, (wanted.get(key) ?? 0) + 1)
  }

  // Short words are dropped from BOTH sides: they are the connectives every
  // German paragraph shares, so counting them would score an unrelated
  // paragraph nearly as well as the real one.
  const scoring = words(haystack).filter((word) => word.text.length >= MIN_SCORING_WORD)
  const size = needleWords.length
  if (scoring.length < size) return null

  const have = new Map<string, number>()
  let overlap = 0

  const add = (word: string): void => {
    const next = (have.get(word) ?? 0) + 1
    have.set(word, next)
    if (next <= (wanted.get(word) ?? 0)) overlap += 1
  }
  const remove = (word: string): void => {
    const current = have.get(word) ?? 0
    if (current <= (wanted.get(word) ?? 0)) overlap -= 1
    have.set(word, current - 1)
  }

  const windows: Array<{ range: Range; score: number }> = []
  for (let i = 0; i < scoring.length; i += 1) {
    add(stem(scoring[i]!.text))
    if (i >= size) remove(stem(scoring[i - size]!.text))
    if (i >= size - 1) {
      windows.push({
        range: { start: scoring[i - size + 1]!.start, end: scoring[i]!.end },
        score: overlap / size,
      })
    }
  }

  const best = windows.reduce<{ range: Range; score: number } | null>(
    (winner, candidate) => (!winner || candidate.score > winner.score ? candidate : winner),
    null,
  )
  if (!best || best.score < MIN_WINDOW_SCORE) return null

  // A page that says nearly the same thing twice — a clause repeated for a
  // second party, a heading echoed in the body — offers two windows that score
  // alike and lie apart. Picking the earlier one would point the reader at the
  // wrong occurrence with exactly the confidence of a real hit, so an unbroken
  // tie somewhere else on the page withdraws the answer instead.
  const rival = windows.some(
    (candidate) =>
      candidate.score >= best.score &&
      (candidate.range.end <= best.range.start || candidate.range.start >= best.range.end),
  )
  return rival ? null : best
}

/**
 * Half the snippet, when the whole of it is not on this page.
 *
 * Two failures the stricter tiers share: a passage that straddles a page break
 * puts only one half on the cited page, and the anchors need words from BOTH
 * ends; a window that finds its twin elsewhere on the page withdraws rather
 * than choose. Splitting at the word boundary nearest the middle and searching
 * each half with the certain tiers — exact, then anchored — recovers the half
 * that IS here. Longest half first: it is the more distinctive of the two.
 */
const partialMatch = (haystack: string, needle: string): Range | null => {
  if (needle.length < MIN_PARTIAL_HALF * 2) return null

  const middle = Math.floor(needle.length / 2)
  let split = -1
  for (let distance = 0; distance <= middle && split === -1; distance += 1) {
    if (needle[middle - distance] === ' ') split = middle - distance
    else if (needle[middle + distance] === ' ') split = middle + distance
  }
  if (split === -1) return null

  const halves = [needle.slice(0, split).trim(), needle.slice(split + 1).trim()]
    .filter((half) => half.length >= MIN_PARTIAL_HALF)
    .sort((a, b) => b.length - a.length)

  for (const half of halves) {
    const exact = haystack.indexOf(half)
    if (exact !== -1) return { start: exact, end: exact + half.length }
    const anchored = anchorMatch(haystack, half)
    if (anchored) return anchored
  }
  return null
}

/** Resolve a normalised character range back to the runs it covers. */
const rangeToRects = (index: PassageIndex, range: Range): HighlightRect[] => {
  const spans = new Map<number, { from: number; to: number }>()
  for (let i = range.start; i < range.end && i < index.chars.length; i += 1) {
    const entry = index.chars[i]!
    if (entry.chunk < 0) continue
    const span = spans.get(entry.chunk)
    if (!span) spans.set(entry.chunk, { from: entry.offset, to: entry.offset })
    else {
      span.from = Math.min(span.from, entry.offset)
      span.to = Math.max(span.to, entry.offset)
    }
  }

  const rects: HighlightRect[] = []
  for (const [chunkIndex, span] of spans) {
    const chunk = index.chunks[chunkIndex]
    if (!chunk || !chunk.text.length || chunk.width <= 0) continue
    // Runs are laid out with one advance per character often enough that a
    // proportional slice lands within a glyph of the truth, and a highlight is
    // forgiving of a glyph. A whole-run match skips the arithmetic entirely.
    const covers = span.from === 0 && span.to >= chunk.text.length - 1
    const start = covers ? 0 : (span.from / chunk.text.length) * chunk.width
    const width = covers
      ? chunk.width
      : ((span.to + 1 - span.from) / chunk.text.length) * chunk.width
    rects.push({ x: chunk.x + start, y: chunk.y, width, height: chunk.height })
  }
  return mergeRects(rects)
}

/**
 * Fuse the per-run rectangles into one band per printed line. A reader sees a
 * highlighted sentence, not the eleven positioned runs the PDF happens to store
 * it as, and a stack of abutting rectangles renders as visible seams.
 */
const mergeRects = (rects: HighlightRect[]): HighlightRect[] => {
  if (rects.length < 2) return rects
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const merged: HighlightRect[] = []
  for (const rect of sorted) {
    const previous = merged[merged.length - 1]
    const sameLine =
      previous &&
      Math.abs(previous.y - rect.y) < Math.min(previous.height, rect.height) * 0.5 &&
      // Only close neighbours join: a gap wider than a line is a column break
      // or a different sentence, and bridging it paints over untouched text.
      rect.x - (previous.x + previous.width) < previous.height
    if (!sameLine) {
      merged.push({ ...rect })
      continue
    }
    const right = Math.max(previous.x + previous.width, rect.x + rect.width)
    const bottom = Math.max(previous.y + previous.height, rect.y + rect.height)
    previous.x = Math.min(previous.x, rect.x)
    previous.y = Math.min(previous.y, rect.y)
    previous.width = right - previous.x
    previous.height = bottom - previous.y
  }
  return merged
}

/**
 * Find `snippet` among a page's text runs and return the rectangles to light
 * up, or `null` when nothing matched confidently enough to point at.
 */
export function findPassage(index: PassageIndex, snippet: string): PassageMatch | null {
  const needle = normalizePassage(snippet)
  if (needle.length < 8 || !index.haystack.length) return null

  const exact = index.haystack.indexOf(needle)
  if (exact !== -1) {
    const rects = rangeToRects(index, { start: exact, end: exact + needle.length })
    if (rects.length) return { rects, matcher: 'exact', score: 1 }
  }

  const anchored = anchorMatch(index.haystack, needle)
  if (anchored) {
    const rects = rangeToRects(index, anchored)
    if (rects.length) return { rects, matcher: 'anchored', score: 1 }
  }

  const windowed = windowMatch(index.haystack, needle)
  if (windowed) {
    const rects = rangeToRects(index, windowed.range)
    if (rects.length) return { rects, matcher: 'windowed', score: windowed.score }
  }

  const partial = partialMatch(index.haystack, needle)
  if (partial) {
    const rects = rangeToRects(index, partial)
    // Half the snippet is half the evidence, and the score says so.
    if (rects.length) return { rects, matcher: 'partial', score: 0.5 }
  }

  return null
}

/** Convenience wrapper for callers holding raw runs. */
export function locatePassage(chunks: TextChunk[], snippet: string): PassageMatch | null {
  return findPassage(buildPassageIndex(chunks), snippet)
}

/** The union of a match's rectangles — what the viewer scrolls into view. */
export function passageBounds(rects: HighlightRect[]): HighlightRect | null {
  if (!rects.length) return null
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
