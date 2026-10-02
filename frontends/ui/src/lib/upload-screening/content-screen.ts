/**
 * The content screen in TypeScript: the office's content terms and number
 * detectors, found and masked in a text (ADR-0077, "Chat messages are screened
 * too").
 *
 * The composer runs it before a chat message leaves the browser, and the BFF
 * runs it on every user message it stores, so what a person typed reaches
 * neither a model nor the stored history with an IBAN in it. It is the twin of
 * `aiq_agent.common.content_screen`, which the ingest job and the chat socket
 * run; both read `tests/fixtures/content_screen_cases.json` (twin under
 * `frontends/ui/tests/fixtures/`) and must give the same matches, masked text
 * and findings for every case. Change one and the other's spec fails.
 *
 * Semantics, in one place each:
 *  - The fold is `foldForScreening` (`./name-screen`), applied per character
 *    and its combining marks, so a span in the folded text maps back to the
 *    characters it came from and a decomposed `ü` folds like the composed one.
 *  - A term matches at a word start and may run on (`Honorar` finds
 *    `Honorarvereinbarung`), never inside a word (`Ehrenhonorar`); its span runs
 *    to the end of that word. A multi-word term matches across any whitespace.
 *  - A detector counts only a checksum-valid number (IBAN mod 97, the Austrian
 *    social-security check digit, Luhn). Digits are ASCII `0-9` on both sides.
 *  - Placeholders are protected: a match overlapping one does not count, so
 *    masking a masked text changes nothing. Masking repeats to a fixpoint,
 *    because removing one number can expose another its digits were hiding.
 *
 * Pure and client-safe. Offsets are UTF-16 indices into the text given.
 */

import { foldForScreening } from './name-screen'
import { SCREENING_DETECTORS, type ScreeningDetector, type UploadScreeningPolicy } from './policy'

export type ContentScreenKind = ScreeningDetector | 'term'

/**
 * What a masked span is replaced with. Domain data, in German, defined once in
 * Python (`content_screen.PLACEHOLDERS`) and mirrored here; the shared fixture
 * holds both to the same strings.
 */
export const SCREENING_PLACEHOLDERS: Readonly<Record<ContentScreenKind, string>> = {
  iban: '[IBAN entfernt]',
  at_svnr: '[SV-Nummer entfernt]',
  credit_card: '[Kartennummer entfernt]',
  term: '[Begriff entfernt]',
}

const MAX_TERMS = 200
const MIN_TERM_CHARS = 2
const MAX_TERM_CHARS = 80
const MAX_MASK_PASSES = 5
const MASK = '••••'

export interface ContentScreenRules {
  terms: readonly string[]
  detectors: readonly ScreeningDetector[]
  /** One per term, same order: the term's folded words, matched literally (`termMatches`). */
  patterns: readonly (readonly string[])[]
}

/** One match, in the ORIGINAL text. */
export interface ContentSpan {
  kind: ContentScreenKind
  start: number
  end: number
  term?: string
  /** A masked sample of a detector's match; never the value. */
  sample?: string
}

/** What a mask removed, per rule. Carries the office's own term or a masked sample, never a matched value. */
export interface ContentFinding {
  kind: ContentScreenKind
  count: number
  term?: string
  sample?: string
}

export interface MaskedText {
  text: string
  findings: ContentFinding[]
}

// ------------------------------------------------------------------ fold

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const MARK = /\p{M}/u
const NO_ALNUM_BEFORE = '(?<![\\p{L}\\p{N}])'
const NO_ALNUM_AFTER = '(?![\\p{L}\\p{N}])'

/** `[start, end)` of each character with the combining marks that follow it. */
function clusters(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let index = 0
  for (const char of text) {
    const last = out[out.length - 1]
    if (last && MARK.test(char)) last[1] = index + char.length
    else out.push([index, index + char.length])
    index += char.length
  }
  return out
}

/** The fold both a term and the text are compared in, built per cluster. */
export function foldContent(text: string): string {
  return clusters(text)
    .map(([start, end]) => foldForScreening(text.slice(start, end)))
    .join('')
}

interface Folded {
  text: string
  starts: number[]
  ends: number[]
}

function foldMapped(text: string): Folded {
  const parts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  for (const [start, end] of clusters(text)) {
    const folded = foldForScreening(text.slice(start, end))
    parts.push(folded)
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(start)
      ends.push(end)
    }
  }
  return { text: parts.join(''), starts, ends }
}

function escapeRegExp(text: string): string {
  // No `-`: outside a class, `\-` is an invalid escape under the `u` flag.
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function termPattern(term: string): string[] {
  return foldContent(term).split(/\s+/).filter(Boolean)
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
const WHITESPACE = /\s/u

/** The code point that ends just before `index`, or '' at the start. */
function codePointBefore(text: string, index: number): string {
  if (index === 0) return ''
  const low = text.charCodeAt(index - 1)
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff
  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text.slice(index - 1, index)
}

/** Where the words match at `start`, separated by at least one whitespace each; the end, or -1. */
function matchWordsAt(text: string, start: number, words: readonly string[]): number {
  let cursor = start
  for (let w = 0; w < words.length; w += 1) {
    if (w > 0) {
      const gap = cursor
      while (cursor < text.length && WHITESPACE.test(text[cursor])) cursor += 1
      if (cursor === gap) return -1
    }
    if (!text.startsWith(words[w], cursor)) return -1
    cursor += words[w].length
  }
  return cursor
}

/**
 * `[start, end)` of each match of a term's words in folded text, leftmost
 * first and not overlapping: no letter or number right before, the words in
 * order with whitespace between. The same matches the Python side's regex
 * finds; done without a regex built from office input, so no term can be read
 * as a pattern (Semgrep `detect-non-literal-regexp`, the precedent in
 * `features/layout/lib/file-reference-markers.ts`).
 */
function* termMatches(text: string, words: readonly string[]): Generator<[number, number]> {
  if (words.length === 0) return
  let index = text.indexOf(words[0])
  while (index !== -1) {
    const end = LETTER_OR_NUMBER.test(codePointBefore(text, index)) ? -1 : matchWordsAt(text, index, words)
    if (end > index) {
      yield [index, end]
      index = text.indexOf(words[0], end)
    } else {
      index = text.indexOf(words[0], index + 1)
    }
  }
}

// ----------------------------------------------------------------- rules

function codePointLength(text: string): number {
  return Array.from(text).length
}

/** Stripped, in bounds, first spelling of each folded form kept, at most 200. */
function normalisedTerms(terms: readonly string[]): string[] {
  const kept = new Map<string, string>()
  for (const term of terms) {
    const stripped = term.split(/\s+/).filter(Boolean).join(' ')
    const length = codePointLength(stripped)
    if (length < MIN_TERM_CHARS || length > MAX_TERM_CHARS) continue
    const key = foldContent(stripped)
    if (!kept.has(key)) kept.set(key, stripped)
  }
  return [...kept.values()].slice(0, MAX_TERMS)
}

/** Rules from terms and detector names, normalised; `null` when nothing is left to check. */
export function buildContentRules(
  terms: readonly string[],
  detectors: readonly string[]
): ContentScreenRules | null {
  const keptTerms = normalisedTerms(terms)
  const wanted = new Set(detectors)
  const keptDetectors = SCREENING_DETECTORS.filter((name) => wanted.has(name))
  if (keptTerms.length === 0 && keptDetectors.length === 0) return null
  return { terms: keptTerms, detectors: keptDetectors, patterns: keptTerms.map(termPattern) }
}

/**
 * What a chat message is screened with: the policy's CONTENT terms and its
 * detectors. Never the name terms, which are for file and folder names and far
 * too broad for prose. `null` when the office switched screening off.
 */
export function chatScreeningRules(policy: UploadScreeningPolicy): ContentScreenRules | null {
  if (!policy.enabled) return null
  return buildContentRules(policy.contentTerms, policy.detectors)
}

// ------------------------------------------------------------- detectors

const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AT: 20,
  BE: 16,
  CH: 21,
  CZ: 24,
  DE: 22,
  ES: 24,
  FR: 27,
  GB: 22,
  HR: 21,
  HU: 28,
  IT: 27,
  LI: 21,
  LU: 20,
  NL: 18,
  PL: 28,
  SI: 19,
  SK: 24,
}

const IBAN_RE = new RegExp(
  NO_ALNUM_BEFORE +
    '[A-Z]{2}[0-9]{2}(?:(?: [A-Z0-9]{4})+(?: [A-Z0-9]{1,3})?|[A-Z0-9]{11,30})' +
    NO_ALNUM_AFTER,
  'gu'
)
const SVNR_RE = new RegExp(NO_ALNUM_BEFORE + '([0-9]{4}) ?([0-9]{6})' + NO_ALNUM_AFTER, 'gu')
const SVNR_WEIGHTS = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6]
const CARD_RE = new RegExp(
  NO_ALNUM_BEFORE + '(?<![0-9][ -])[2-6](?:[ -]?[0-9]){12,18}(?![ -]?[0-9])' + NO_ALNUM_AFTER,
  'gu'
)

export function validIban(compact: string): boolean {
  const expected = IBAN_LENGTHS[compact.slice(0, 2)]
  if (expected !== undefined && compact.length !== expected) return false
  if (compact.length < 15 || compact.length > 34) return false
  let remainder = 0
  for (const char of compact.slice(4) + compact.slice(0, 4)) {
    for (const digit of String(parseInt(char, 36)))
      remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** The valid IBAN a printed candidate starts with, longest first, and its printed length. */
function ibanIn(candidate: string): { compact: string; printed: number } | null {
  const groups = candidate.split(' ')
  for (let end = groups.length; end > 0; end -= 1) {
    const compact = groups.slice(0, end).join('')
    if (validIban(compact)) return { compact, printed: groups.slice(0, end).join(' ').length }
  }
  return null
}

function maskIban(compact: string): string {
  const hidden = Math.ceil(Math.max(compact.length - 8, 0) / 4)
  return [compact.slice(0, 4), ...Array<string>(hidden).fill(MASK), compact.slice(-4)].join(' ')
}

export function validAtSvnr(digits: string): boolean {
  if (!/^[0-9]{10}$/.test(digits) || digits[0] === '0') return false
  let sum = 0
  for (let i = 0; i < 10; i += 1) sum += Number(digits[i]) * SVNR_WEIGHTS[i]
  const check = sum % 11
  if (check === 10 || check !== Number(digits[3])) return false
  const day = Number(digits.slice(4, 6))
  const month = Number(digits.slice(6, 8))
  return day >= 1 && day <= 31 && month >= 1 && month <= 15
}

export function luhnValid(digits: string): boolean {
  let total = 0
  const reversed = [...digits].reverse()
  for (let index = 0; index < reversed.length; index += 1) {
    const value = Number(reversed[index]) * (index % 2 ? 2 : 1)
    total += value > 9 ? value - 9 : value
  }
  return total % 10 === 0
}

function validCard(digits: string): boolean {
  return (
    digits.length >= 13 && digits.length <= 19 && '23456'.includes(digits[0]) && luhnValid(digits)
  )
}

function* ibanSpans(text: string): Generator<ContentSpan> {
  for (const match of text.matchAll(IBAN_RE)) {
    const found = ibanIn(match[0])
    if (found) {
      yield {
        kind: 'iban',
        start: match.index,
        end: match.index + found.printed,
        sample: maskIban(found.compact),
      }
    }
  }
}

function* svnrSpans(text: string): Generator<ContentSpan> {
  for (const match of text.matchAll(SVNR_RE)) {
    const digits = match[1] + match[2]
    if (validAtSvnr(digits)) {
      yield {
        kind: 'at_svnr',
        start: match.index,
        end: match.index + match[0].length,
        sample: `${MASK} ${MASK}${digits.slice(-2)}`,
      }
    }
  }
}

function* cardSpans(text: string): Generator<ContentSpan> {
  for (const match of text.matchAll(CARD_RE)) {
    const digits = match[0].replace(/[ -]/g, '')
    if (validCard(digits)) {
      yield {
        kind: 'credit_card',
        start: match.index,
        end: match.index + match[0].length,
        sample: `${MASK} ${digits.slice(-4)}`,
      }
    }
  }
}

const DETECTOR_SPANS: Readonly<Record<ScreeningDetector, (text: string) => Iterable<ContentSpan>>> =
  {
    iban: ibanSpans,
    at_svnr: svnrSpans,
    credit_card: cardSpans,
  }

// ----------------------------------------------------------------- spans

/** `end` moved over the rest of the word it is in: letters, digits and their combining marks. */
function wordEnd(text: string, end: number): number {
  let cursor = end
  while (cursor < text.length) {
    const char = String.fromCodePoint(text.codePointAt(cursor) ?? 0)
    if (!WORD_CHAR.test(char)) break
    cursor += char.length
  }
  return cursor
}

function* termSpans(text: string, rules: ContentScreenRules): Generator<ContentSpan> {
  const folded = foldMapped(text)
  for (let i = 0; i < rules.terms.length; i += 1) {
    for (const [matchStart, matchEnd] of termMatches(folded.text, rules.patterns[i])) {
      const start = folded.starts[matchStart]
      const end = wordEnd(text, folded.ends[matchEnd - 1])
      yield { kind: 'term', start, end, term: rules.terms[i] }
    }
  }
}

const PLACEHOLDER_RE = new RegExp(
  Object.values(SCREENING_PLACEHOLDERS).map(escapeRegExp).join('|'),
  'g'
)

/**
 * Every match of every rule: terms in the rules' order, then the detectors,
 * each by position. Overlapping matches are all kept; a match overlapping a
 * placeholder is dropped.
 */
export function findSpans(text: string, rules: ContentScreenRules): ContentSpan[] {
  if (!text) return []
  const protectedRegions = [...text.matchAll(PLACEHOLDER_RE)].map(
    (match) => [match.index, match.index + match[0].length] as const
  )
  const spans = [...termSpans(text, rules)]
  for (const name of rules.detectors) spans.push(...DETECTOR_SPANS[name](text))
  return spans.filter(
    (span) => !protectedRegions.some(([start, end]) => span.start < end && start < span.end)
  )
}

// --------------------------------------------------------------- masking

function merged(spans: readonly ContentSpan[]): ContentSpan[] {
  const out: ContentSpan[] = []
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  for (const span of ordered) {
    const last = out[out.length - 1]
    if (last && span.start < last.end)
      out[out.length - 1] = { ...last, end: Math.max(last.end, span.end) }
    else out.push(span)
  }
  return out
}

function replaced(text: string, spans: readonly ContentSpan[]): string {
  let out = ''
  let cursor = 0
  for (const span of merged(spans)) {
    out += text.slice(cursor, span.start) + SCREENING_PLACEHOLDERS[span.kind]
    cursor = span.end
  }
  return out + text.slice(cursor)
}

function findingsOf(spans: readonly ContentSpan[], rules: ContentScreenRules): ContentFinding[] {
  const order: Array<{ kind: ContentScreenKind; term?: string }> = [
    ...rules.terms.map((term) => ({ kind: 'term' as const, term })),
    ...rules.detectors.map((kind) => ({ kind })),
  ]
  const findings: ContentFinding[] = []
  for (const rule of order) {
    const matched = spans.filter((span) => span.kind === rule.kind && span.term === rule.term)
    if (matched.length === 0) continue
    const finding: ContentFinding = { kind: rule.kind, count: matched.length }
    if (rule.term !== undefined) finding.term = rule.term
    if (matched[0].sample !== undefined) finding.sample = matched[0].sample
    findings.push(finding)
  }
  return findings
}

/**
 * `text` with every term and detector match replaced by its placeholder, and
 * what was found. `null` rules mask nothing. Idempotent: masking the result
 * again returns it unchanged with no findings.
 */
export function maskText(text: string, rules: ContentScreenRules | null): MaskedText {
  if (!rules || !text) return { text, findings: [] }
  const found: ContentSpan[] = []
  let current = text
  for (let pass = 0; pass < MAX_MASK_PASSES; pass += 1) {
    const spans = findSpans(current, rules)
    if (spans.length === 0) break
    found.push(...spans)
    current = replaced(current, spans)
  }
  return { text: current, findings: findingsOf(found, rules) }
}
