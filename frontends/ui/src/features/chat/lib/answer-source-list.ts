/**
 * Consolidated answer provenance — one source list instead of two.
 *
 * An answer used to state its sources TWICE, and each statement dropped half
 * the truth:
 *
 *  1. The written "## Quellen" / "**References:**" section inside the answer
 *     markdown (backend `verify_citations`): carries the `[N]` numbers that the
 *     inline markers point at, the full title, the page, the real URL — but as
 *     dead text with a raw `[KB]`/`[RIS]` token, no provenance colour and no way
 *     to open anything.
 *  2. The "Belegt durch" chip row (structured `sources` wire): carries the
 *     provenance tint, the OIB/RIS authority badge, click-to-preview (PDF at the
 *     cited page) and the bindingness popover — but truncated labels, no page,
 *     and no idea which `[N]` it is.
 *
 * This module folds them into ONE ordered list: the written entries supply
 * number + full title + locator, the structured refs supply colour, authority
 * and the preview target. Nothing is invented and nothing is lost — an entry
 * with no matching ref still renders (as its own source, openable when its
 * locator resolves), and a ref with no entry still renders (unnumbered, after
 * the numbered ones).
 *
 * Matching is by IDENTITY, in this order:
 *   1. the backend's own `[N]` (wire `number`) — authoritative, no guessing;
 *   2. the canonical OIB document key (`oibDocumentKey`);
 *   3. filename, then URL.
 */

import {
  splitReportSources,
  linkifyCitationMarkers,
  type ReportSourceEntry,
  type ReportSourceKind,
} from '@/features/layout/lib/report-citations'
import { KIND_TO_SIGNAL } from './source-kinds'
import type { CitationSource } from '../types'
import {
  MAX_ANSWER_SOURCES,
  deriveAnswerSources,
  hostnameOf,
  isHttpUrl,
  oibDocumentKey,
  parseKbLocator,
  type AnswerSourceKind,
  type AnswerSourceRef,
} from './answer-sources'
import type { GridCard } from '@/shared/cards/schemas'

/** DOM id prefix for a numbered source row under an answer. */
export const ANSWER_SOURCE_ANCHOR_PREFIX = 'answer-source-'

/**
 * Per-message anchor prefix. Several answers share one scroll container and each
 * numbers its sources from 1, so the message id has to be part of the DOM id or
 * an inline `[1]` in the newest answer would scroll to the oldest one's source.
 */
export const answerSourceAnchorPrefix = (messageId: string): string =>
  `${ANSWER_SOURCE_ANCHOR_PREFIX}${messageId}-`

/** One row of the consolidated provenance list. */
export interface AnswerSourceItem {
  /** Stable render key. */
  key: string
  /** The `[N]` this source carries in the prose, when known. */
  number?: number
  /** Chip payload (label, tint, authority, preview target). */
  ref: AnswerSourceRef
  /** Cited page, for document sources — shown as quiet meta after the chip. */
  page?: number
  /** Hostname, for link sources — shown as quiet meta after the chip. */
  host?: string
}

export interface AnswerBodySplit {
  /** The answer markdown without its written sources section. */
  body: string
  /** Parsed entries of that section (empty when the answer had none). */
  entries: ReportSourceEntry[]
}

/** Written source-entry origin token → the chip's origin kind. */
const ENTRY_KIND_TO_SOURCE_KIND: Record<ReportSourceKind, AnswerSourceKind> = {
  kb: 'kb',
  web: 'web',
  ris: 'ris',
}

/** A markdown link, e.g. "[OIB RL 4](https://…)". */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i
/** A bare URL anywhere in the entry text. */
const BARE_URL_RE = /(https?:\/\/[^\s)>\]]+)/i
/** Trailing " — url" / " - url" / " – url" separator before a bare URL. */
const URL_SEPARATOR_RE = /[\s]*[-–—:]?[\s]*$/
/** Markdown emphasis/code markers a written entry may carry. */
const MD_MARKERS_RE = /[*`]/g
/** Looks like a filename ("plan.pdf") rather than a title. */
const FILENAME_LIKE_RE = /^\S.*\.\w{2,5}$/

/**
 * Split the answer's written sources section off its body and linkify the inline
 * `[N]` markers to the consolidated list's rows.
 *
 * Returns the answer unchanged when it carries no recognizable section, so
 * answers without one (and meta turns) render exactly as before.
 */
export const splitAnswerBody = (markdown: string, anchorPrefix: string): AnswerBodySplit => {
  const split = splitReportSources(markdown)
  if (split.entries.length === 0) return { body: markdown, entries: [] }
  const numbers = new Set(split.entries.map((entry) => entry.number))
  return { body: linkifyCitationMarkers(split.body, numbers, anchorPrefix), entries: split.entries }
}

/** Facts parsed out of one written source entry. */
interface ParsedEntry {
  number: number
  kind?: AnswerSourceKind
  /** Display title with any URL / markdown link syntax removed. */
  title: string
  url?: string
  fileName?: string
  page?: number
}

const parseEntry = (entry: ReportSourceEntry): ParsedEntry => {
  const text = entry.markdown.replace(MD_MARKERS_RE, '').trim()

  let title = text
  let url: string | undefined

  const linkMatch = MARKDOWN_LINK_RE.exec(text)
  if (linkMatch) {
    url = linkMatch[2]
    title = text.replace(MARKDOWN_LINK_RE, linkMatch[1]).trim()
  } else {
    const urlMatch = BARE_URL_RE.exec(text)
    if (urlMatch) {
      url = urlMatch[1]
      title = text.slice(0, urlMatch.index).replace(URL_SEPARATOR_RE, '').trim()
    }
  }

  const locator = parseKbLocator(title || text)
  return {
    number: entry.number,
    kind: entry.sourceKind ? ENTRY_KIND_TO_SOURCE_KIND[entry.sourceKind] : undefined,
    // A pure locator ("plan.pdf, p.4") is a reference, not a title: the page
    // travels as its own quiet meta, so it must not also sit in the label.
    title: locator?.filename || title || url || text,
    url,
    fileName: locator?.filename,
    page: locator?.page,
  }
}

/** Identity keys a written entry can be matched on. */
const entryKeys = (parsed: ParsedEntry): string[] => {
  const keys: string[] = []
  const oib = oibDocumentKey(parsed.fileName || parsed.title)
  if (oib) keys.push(`oib:${oib}`)
  if (parsed.fileName) keys.push(`file:${parsed.fileName.toLowerCase()}`)
  if (parsed.url) keys.push(`url:${parsed.url.toLowerCase()}`)
  return keys
}

/** Identity keys a structured ref can be matched on. */
const refKeys = (ref: AnswerSourceRef): string[] => {
  const keys: string[] = []
  const citation = ref.citation
  const oib = oibDocumentKey(citation?.fileName || citation?.citationKey || citation?.title || ref.label)
  if (oib) keys.push(`oib:${oib}`)
  const fileName = citation?.fileName ?? parseKbLocator(citation?.citationKey ?? '')?.filename
  if (fileName) keys.push(`file:${fileName.toLowerCase()}`)
  if (ref.url) keys.push(`url:${ref.url.toLowerCase()}`)
  return keys
}

/**
 * The better of the two labels. The chip's label is a hostname for links and
 * sometimes a bare filename for documents; the written entry usually carries the
 * human title ("Wiener Garagengesetz 2008 …") the chip was missing. Prefer the
 * entry title only when the chip label is one of those weak forms.
 */
const bestLabel = (refLabel: string, entryTitle: string | undefined): string => {
  const title = entryTitle?.trim()
  if (!title) return refLabel
  if (!refLabel) return title
  const refIsWeak =
    FILENAME_LIKE_RE.test(refLabel) || refLabel.endsWith('…') || /^[\w.-]+\.[a-z]{2,}$/i.test(refLabel)
  const titleIsWeak = FILENAME_LIKE_RE.test(title)
  return refIsWeak && !titleIsWeak ? title : refLabel
}

/** Synthesize a ref for a written entry that no structured source matched. */
const refFromEntry = (parsed: ParsedEntry): AnswerSourceRef => {
  const kind: AnswerSourceKind = parsed.kind ?? (isHttpUrl(parsed.url) ? 'web' : 'kb')
  // A written entry carries no lane, so it can only claim the coarse family:
  // [KB]/[RIS] are Baurecht-ish law-tinted, [Web] stays the neutral auto family.
  const signal = kind === 'web' ? KIND_TO_SIGNAL.web : KIND_TO_SIGNAL.baurecht
  // Keep the locator on a citation-shaped object so the SAME preview resolution
  // the chips use (project upload → base corpus → info) applies to entry-only
  // sources too, instead of them degrading to dead text as they did before.
  const citation: CitationSource | undefined = parsed.fileName
    ? {
        id: `entry-${parsed.number}`,
        content: parsed.fileName + (parsed.page ? `, p.${parsed.page}` : ''),
        timestamp: new Date(0),
        origin: kind,
        fileName: parsed.fileName,
        page: parsed.page,
        title: parsed.title,
        number: parsed.number,
      }
    : undefined

  return {
    key: `entry-${parsed.number}`,
    label: parsed.title,
    kind,
    signal,
    authority: kind === 'ris' ? 'RIS' : undefined,
    url: isHttpUrl(parsed.url) ? parsed.url : undefined,
    number: parsed.number,
    citation,
  }
}

/**
 * Merge the answer's written source entries with its structured provenance refs
 * into one ordered list: numbered sources first (in citation order), then any
 * source the prose never numbered.
 */
export const mergeAnswerSources = (
  entries: ReportSourceEntry[],
  refs: AnswerSourceRef[],
  limit: number = MAX_ANSWER_SOURCES
): AnswerSourceItem[] => {
  const unmatched = [...refs]

  const take = (predicate: (ref: AnswerSourceRef) => boolean): AnswerSourceRef | undefined => {
    const index = unmatched.findIndex(predicate)
    return index === -1 ? undefined : unmatched.splice(index, 1)[0]
  }

  const items: AnswerSourceItem[] = []

  for (const entry of entries) {
    const parsed = parseEntry(entry)
    // 1. The backend's own [N] — authoritative, no guessing.
    const keys = new Set(entryKeys(parsed))
    const ref =
      take((candidate) => candidate.number === parsed.number) ??
      // 2./3. identity: OIB document, filename, URL.
      take((candidate) => refKeys(candidate).some((key) => keys.has(key)))

    const merged: AnswerSourceRef = ref
      ? { ...ref, number: parsed.number, label: bestLabel(ref.label, parsed.title) }
      : refFromEntry(parsed)
    const url = merged.url ?? (isHttpUrl(parsed.url) ? parsed.url : undefined)
    items.push({
      key: merged.key,
      number: parsed.number,
      ref: merged,
      page: merged.citation?.page ?? parsed.page,
      host: url ? (hostnameOf(url) ?? undefined) : undefined,
    })
  }

  for (const ref of unmatched) {
    items.push({
      key: ref.key,
      number: ref.number,
      ref,
      page: ref.citation?.page,
      host: ref.url ? (hostnameOf(ref.url) ?? undefined) : undefined,
    })
  }

  // Cap the tail, never a numbered source: dropping one would leave an inline
  // [N] marker in the prose pointing at a row that does not exist.
  const numbered = items.filter((item) => item.number != null)
  const rest = items.filter((item) => item.number == null)
  return [...numbered, ...rest.slice(0, Math.max(0, limit - numbered.length))]
}

/**
 * The consolidated provenance list for one answer: written entries (if the
 * answer carried a sources section) merged with the structured chips.
 *
 * `limit` caps the UNNUMBERED tail. It defaults to {@link MAX_ANSWER_SOURCES},
 * which is right for the chat answer's chip row — a summary, not a dump. Pass
 * `Infinity` for a surface that is a BIBLIOGRAPHY rather than a summary (the
 * report's sources section), where silently showing 8 of 12 sources would
 * undercut the completeness the list exists to demonstrate.
 */
export const answerSourceItems = (
  entries: ReportSourceEntry[] | undefined,
  citations: CitationSource[] | undefined,
  cards: GridCard[] | undefined,
  limit: number = MAX_ANSWER_SOURCES
): AnswerSourceItem[] => {
  const hasEntries = !!entries && entries.length > 0
  // Uncapped when merging: the cap is applied after, so a numbered entry can
  // never lose its structured half to a truncated ref list.
  const refs = deriveAnswerSources(citations, cards, hasEntries ? Infinity : limit)
  if (!hasEntries) {
    return refs.map((ref) => ({
      key: ref.key,
      number: ref.number,
      ref,
      page: ref.citation?.page,
      host: ref.url ? (hostnameOf(ref.url) ?? undefined) : undefined,
    }))
  }
  return mergeAnswerSources(entries, refs, limit)
}
