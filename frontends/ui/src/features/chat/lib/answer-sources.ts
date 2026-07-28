/**
 * "Belegt durch" answer-source derivation (WS-3, spec §2.1(3)).
 *
 * Turns the citation/source data that ALREADY exists on an agent_response
 * message into provenance chips — nothing is fabricated:
 *
 *  - `message.citations` (deep-research path): url + content pairs collected
 *    from citation SSE events. Origin is parsed from the backend's leading
 *    `[KB]/[RIS]/[Web]` token when present (same deterministic token the
 *    report sources section carries — see layout/lib/report-citations.ts),
 *    with URL heuristics as fallback (ris.bka.gv.at → RIS, http(s) → Web,
 *    anything else → KB).
 *  - `message.cards` (shallow-answer path): `legal_basis` cards name the law /
 *    OIB Richtlinie grounding the answer → law-signal chips.
 *
 * When a message carries neither, the row renders nothing.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { SourceSignal, SourceTint } from '@/features/layout/lib/source-presets'
import type { CitationSource } from '../types'
import { accentForLane, authorityTag, tintForKind } from './source-kinds'

/** Origin of an answer source — mirrors ReportSourceKind (kb/ris/web). */
export type AnswerSourceKind = 'kb' | 'ris' | 'web'

/**
 * Legacy origin → tint family, used only for messages persisted before the
 * canonical wire `kind` existed. New messages carry `citation.kind` and map via
 * `KIND_TO_SIGNAL` (which correctly sends the OIB corpus to the law family).
 */
const LEGACY_KIND_TO_SIGNAL: Record<AnswerSourceKind, SourceSignal> = {
  kb: 'project',
  ris: 'law',
  web: 'auto',
}

export interface AnswerSourceRef {
  /** Stable key for rendering */
  key: string
  /** Short human-readable label (hostname, law name, …) */
  label: string
  /** Parsed origin (kb/ris/web) — drives preview-target resolution. */
  kind: AnswerSourceKind
  /**
   * The `--source-*` tint family the chip renders in. Derived from the wire
   * `kind`, then refined by the fine lane (`accentForLane`) so an OIB chip and
   * an OIB card in the Herleitung are the same colour.
   */
  signal: SourceTint
  /** Compact authority badge (OIB / RIS / ÖNORM) shown on the chip, if any. */
  authority?: string
  /** Outbound link, only when the citation has a real http(s) URL */
  url?: string
  /**
   * The `[N]` marker this source carries in the answer prose, when known
   * (backend `verify_citations` → wire `number`, or matched from the answer's
   * written source list). Drives the numbered provenance list and the in-page
   * anchor an inline `[N]` marker scrolls to.
   */
  number?: number
  /**
   * The underlying citation, kept so the chip can resolve a preview target
   * (WS-9). Absent for card-derived refs (legal_basis), which carry `snippet`.
   */
  citation?: CitationSource
  /**
   * Cited passage / literal excerpt for card-derived refs (legal_basis
   * `original_text`, falling back to `summary`). Shown in the preview popover.
   */
  snippet?: string
}

/** Max chips rendered under one answer — keep the row a summary, not a dump. */
export const MAX_ANSWER_SOURCES = 8

/**
 * Canonical identity for an OIB base-corpus document, derived PURELY from either
 * its filename (`oib-rl_2_ausgabe_mai_2023.pdf`) or a human law label
 * (`OIB-Richtlinie 2, Ausgabe Mai 2023`, `OIB RL 2 Leitfaden`, `OIB 2.3`).
 *
 * This is the shared key that collapses the two provenance streams — a KB
 * citation and a `legal_basis` card that name the SAME Richtlinie — into one
 * chip. It intentionally ignores the edition and any section/paragraph, since
 * those do not change WHICH document is being cited. Returns `null` for anything
 * that is not recognisably an OIB document, so non-OIB sources keep their own
 * (filename/url/label) dedup identity untouched.
 *
 * Mirrors the backend filename convention (norm_registry.oib_doc_class /
 * guess_display_title) but only needs to produce a stable key, not a name.
 */
const OIB_NUMBER_RE = /(?:oib[\s._-]*(?:rl|richtlinie)?|richtlinie)[\s._-]*(\d+(?:\.\d+)?)/i

export const oibDocumentKey = (nameOrLabel: string | undefined | null): string | null => {
  const raw = (nameOrLabel ?? '').trim().toLowerCase()
  if (!raw || !/(oib|richtlinie)/.test(raw)) return null

  const role = /erl[aä]uterung|erlaeuterung/.test(raw)
    ? 'erl'
    : /[äa]nderung|aenderung/.test(raw)
      ? 'aen'
      : ''
  const leitfaden = /leitfaden/.test(raw) ? 'lf' : ''

  let subject: string | null = null
  if (/begriffsbestimmung/.test(raw)) subject = 'begriffe'
  else if (/zitierte/.test(raw) && /normen/.test(raw)) subject = 'zitnormen'
  else subject = OIB_NUMBER_RE.exec(raw)?.[1] ?? null

  if (!subject) return null
  return ['oib', role, subject, leitfaden].filter(Boolean).join(':')
}

/** Leading backend origin token, e.g. "[RIS] …" (citation_verification). */
const ORIGIN_TOKEN_RE = /^\s*\[(KB|Web|RIS)\]\s*/i

const TOKEN_TO_KIND: Record<string, AnswerSourceKind> = {
  kb: 'kb',
  web: 'web',
  ris: 'ris',
}

export const isHttpUrl = (url: string | undefined | null): boolean =>
  !!url && /^https?:\/\//i.test(url)

export const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

/** Classify a single citation into an origin kind (token first, then structured origin, then URL). */
const classifyCitation = (
  citation: Pick<CitationSource, 'url' | 'content' | 'origin'>
): AnswerSourceKind => {
  if (citation.origin === 'kb' || citation.origin === 'ris' || citation.origin === 'web') {
    return citation.origin
  }
  const tokenMatch = citation.content?.match(ORIGIN_TOKEN_RE)
  if (tokenMatch) return TOKEN_TO_KIND[tokenMatch[1].toLowerCase()]
  if (citation.url && /ris\.bka\.gv\.at/i.test(citation.url)) return 'ris'
  if (isHttpUrl(citation.url)) return 'web'
  return 'kb'
}

/** Short display label for a citation: hostname for links, else title/content/url. */
const citationLabel = (
  citation: Pick<CitationSource, 'url' | 'content' | 'title' | 'fileName' | 'citationKey'>
): string => {
  if (isHttpUrl(citation.url)) {
    const host = hostnameOf(citation.url!)
    if (host) return host
  }
  const structured =
    citation.title?.trim() ||
    citation.fileName?.trim() ||
    citation.citationKey?.replace(ORIGIN_TOKEN_RE, '').trim()
  if (structured) {
    return structured.length > 48 ? `${structured.slice(0, 47)}…` : structured
  }
  const text = (citation.content ?? '').replace(ORIGIN_TOKEN_RE, '').trim()
  const firstLine = text.split('\n')[0]?.trim()
  const base = firstLine || citation.url || ''
  return base.length > 48 ? `${base.slice(0, 47)}…` : base
}

/**
 * Derive the provenance chips for one agent response from data that already
 * exists on the message. Deduplicates by url/label and caps the row length.
 *
 * `limit` exists for the consolidated list (`answer-source-list.ts`), which
 * merges these refs with the answer's WRITTEN source entries and must not have
 * a numbered entry silently dropped before the merge — it applies its own cap
 * afterwards.
 */
export const deriveAnswerSources = (
  citations?: CitationSource[],
  cards?: GridCard[],
  limit: number = MAX_ANSWER_SOURCES
): AnswerSourceRef[] => {
  const refs: AnswerSourceRef[] = []
  const seen = new Set<string>()

  const push = (ref: AnswerSourceRef, dedupeKey: string) => {
    const normalized = dedupeKey.toLowerCase()
    if (!ref.label || seen.has(normalized)) return
    seen.add(normalized)
    refs.push(ref)
  }

  if (citations && citations.length > 0) {
    // Prefer sources that were actually cited in the answer; fall back to the
    // full collected list only when no cited-flagged entries exist (older
    // persisted messages predate the flag).
    const cited = citations.filter((c) => c.isCited)
    const relevant = cited.length > 0 ? cited : citations
    for (const citation of relevant) {
      const kind = classifyCitation(citation)
      // Color by the canonical wire kind (OIB corpus + RIS → law family);
      // fall back to the legacy origin mapping only for pre-kind messages.
      const baseSignal = citation.kind ? tintForKind(citation.kind) : LEGACY_KIND_TO_SIGNAL[kind]
      const signal = accentForLane(citation.lane, baseSignal)
      // A tool result is a computation, not a document — it sits on no rung of
      // the authority ladder, so it never carries a badge.
      const authority =
        citation.kind === 'tool'
          ? undefined
          : citation.lane
            ? (authorityTag(citation.lane) ?? undefined)
            : kind === 'ris'
              ? 'RIS'
              : undefined
      // Prefer the canonical OIB document identity so a KB citation and a
      // legal_basis card naming the same Richtlinie collapse to one chip; fall
      // back to the filename/url identity for everything else.
      const dedupe =
        oibDocumentKey(citation.fileName || citation.citationKey || citation.title) ||
        citation.citationKey ||
        citation.fileName ||
        citation.url ||
        citationLabel(citation)
      push(
        {
          key: `citation-${citation.id || dedupe}`,
          label: citationLabel(citation),
          kind,
          signal,
          authority,
          url: isHttpUrl(citation.url) ? citation.url : undefined,
          number: citation.number,
          citation,
        },
        dedupe
      )
    }
  }

  if (cards && cards.length > 0) {
    for (const card of cards) {
      if (card.type !== 'legal_basis') continue
      const label = [card.law, card.section ?? card.article ?? undefined]
        .filter(Boolean)
        .join(' ')
      const snippet = card.original_text ?? card.summary ?? undefined
      // legal_basis cards name the building-law grounding → the Baurecht (law)
      // family; tag OIB vs. RIS from the cited law's name.
      const authority = /oib/i.test(label) ? 'OIB' : 'RIS'
      // Dedup on the canonical OIB identity so a card that names the same
      // Richtlinie as an already-listed KB citation does not add a second chip;
      // non-OIB legal bases keep their own `legal-<label>` identity.
      const dedupe = oibDocumentKey(card.law) ?? `legal-${label}`
      push(
        { key: `legal-${label}`, label, kind: 'ris', signal: authority === 'OIB' ? 'oib' : 'law', authority, snippet },
        dedupe
      )
    }
  }

  return refs.slice(0, limit)
}

// ---------------------------------------------------------------------------
// WS-9 — citation → preview-target resolution (spec §6 WS-9, backlog FB-4)
// ---------------------------------------------------------------------------

/**
 * The minimal shape of a STORED document a citation can resolve against — a
 * project upload (`GET /api/documents?projectId=…`) or an org Archiv document
 * (`GET /api/archiv/documents`). Both are DB-backed rows opened through the
 * same scope-aware `/api/documents/{id}/preview`, so they share one list;
 * project documents come first, so a filename held in both resolves to the one
 * belonging to the project in view.
 */
export interface StoredDocumentRef {
  id: string
  filename: string
  contentType?: string | null
}

/** @deprecated Use {@link StoredDocumentRef} — the list is no longer project-only. */
export type ProjectDocumentRef = StoredDocumentRef

/**
 * Where a clicked citation chip can take the user:
 *  - `url`      — a real outbound link (Web / RIS): keep linking out.
 *  - `document` — an in-app document preview, either a stored document (a
 *                 project upload or an org Archiv document, both presigned via
 *                 /api/documents/{id}/preview) or a base-corpus PDF
 *                 (/api/knowledge-base/documents/{fileName}).
 *  - `info`     — nothing openable: show title/origin/snippet only, never a
 *                 broken viewer.
 */
export type CitationTarget =
  | { kind: 'url'; url: string; origin: AnswerSourceKind }
  | {
      kind: 'document'
      origin: 'kb'
      /** Display title (the resolved document's filename). */
      title: string
      /** 1-based page from the citation locator ("file.pdf, p.3"), if any. */
      page?: number
      /** Cited passage text when the citation carries one. */
      snippet?: string
      document:
        | { type: 'stored'; id: string; filename: string; contentType: string | null }
        | { type: 'base'; fileName: string }
    }
  | { kind: 'info'; origin: AnswerSourceKind; title: string; snippet?: string }

/** A knowledge-layer citation locator: filename + optional page. */
export interface KbCitationLocator {
  filename: string
  page?: number
}

/**
 * Page token of a KB citation key — mirrors the backend's `_PAGE_RE`
 * (citation_verification.py): the token must be a separate word so filenames
 * containing "p"+digits ("Top2.pdf") are never truncated into bogus pages.
 */
const PAGE_REF_RE = /[,\s]\s*(?:p\.?|page)\s*(\d+)(?=\s*(?:[,)\]]|$))/i

/** A plausible filename (mirrors the backend's `_KL_CITATION_PATTERN_RE`). */
const FILENAME_RE = /^.+\.\w{2,5}$/

/** Pseudo-URL scheme prefix (kb://…, doc://…) sometimes carried by citations. */
const PSEUDO_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Parse a knowledge-layer locator ("Brandschutzkonzept.pdf, p.3") out of a
 * free-text citation line. Returns null when the text does not look like a
 * document reference. Mirrors the backend's `_parse_citation_key`.
 */
export const parseKbLocator = (text: string): KbCitationLocator | null => {
  const line = text.replace(ORIGIN_TOKEN_RE, '').split('\n')[0]?.trim() ?? ''
  if (!line) return null
  const pageMatch = PAGE_REF_RE.exec(line)
  const page = pageMatch ? Number(pageMatch[1]) : undefined
  const filename = (pageMatch ? line.slice(0, pageMatch.index) : line)
    .replace(/[\s,]+$/, '')
    .trim()
  if (!FILENAME_RE.test(filename)) return null
  return { filename, page }
}

/** Locator from a citation: structured fields first, then content / pseudo-URL. */
const locatorForCitation = (
  citation: Pick<CitationSource, 'url' | 'content' | 'fileName' | 'page' | 'citationKey'>
): KbCitationLocator | null => {
  if (citation.fileName?.trim()) {
    return {
      filename: citation.fileName.trim(),
      page: typeof citation.page === 'number' ? citation.page : undefined,
    }
  }
  if (citation.citationKey?.trim()) {
    const fromKey = parseKbLocator(citation.citationKey)
    if (fromKey) return fromKey
  }
  const fromContent = citation.content ? parseKbLocator(citation.content) : null
  if (fromContent) return fromContent
  if (citation.url && !isHttpUrl(citation.url)) {
    const basename = citation.url.replace(PSEUDO_SCHEME_RE, '').split('/').pop() ?? ''
    try {
      return parseKbLocator(decodeURIComponent(basename))
    } catch {
      return parseKbLocator(basename)
    }
  }
  return null
}

/** Longest snippet shown in a preview surface. */
const MAX_SNIPPET_LENGTH = 600

/**
 * Cited-passage text carried by a citation, if any. The deep-research SSE
 * events set `content` to the URL itself and KB locators are pure "file, p.N"
 * references — neither is a passage, so both yield undefined.
 */
export const citationSnippet = (
  citation: Pick<CitationSource, 'url' | 'content'>
): string | undefined => {
  const text = (citation.content ?? '').replace(ORIGIN_TOKEN_RE, '').trim()
  const url = citation.url?.trim() ?? ''
  if (!text || (url && text === url)) return undefined
  const lines = text.split('\n')
  const firstLine = lines[0]?.trim() ?? ''
  // A leading locator line ("file.pdf, p.3") is a reference, not a passage.
  const body = parseKbLocator(firstLine) ? lines.slice(1).join('\n').trim() : text
  if (!body) return undefined
  return body.length > MAX_SNIPPET_LENGTH ? `${body.slice(0, MAX_SNIPPET_LENGTH - 1)}…` : body
}

/**
 * Content types the existing preview machinery can render inline (mirrors
 * PREVIEW_TYPES in the Files preview pane — PDF iframe + browser image types).
 */
const PREVIEWABLE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
])

const isPreviewableContentType = (contentType: string | null | undefined): boolean =>
  contentType != null && PREVIEWABLE_CONTENT_TYPES.has(contentType.toLowerCase())

/**
 * Resolve a citation to its preview target — pure; all data is passed in.
 *
 *  1. A real http(s) URL always links out (Web stays web, RIS keeps hitting
 *     the real RIS).
 *  2. Otherwise, a knowledge-layer locator is matched (case-insensitively, by
 *     exact filename) against the stored documents — project uploads AND the
 *     org Archiv — then the base corpus. Stored matches must be
 *     inline-previewable (PDF/image); anything else degrades to `info` rather
 *     than opening a viewer that cannot render.
 *  3. Anything unresolvable becomes an `info` target (title/origin/snippet).
 *
 * `storedDocuments` / `baseCorpusFiles` are optional: without them (lists not
 * loaded, or the caller cannot fetch), resolution honestly degrades to `info`.
 * Omitting the Archiv from that list is what made every `buero`-kind citation
 * permanently unopenable while project and Baurecht citations opened fine.
 */
export const resolveCitationTarget = (
  citation: Pick<CitationSource, 'url' | 'content' | 'fileName' | 'page' | 'citationKey' | 'origin' | 'title'>,
  storedDocuments?: StoredDocumentRef[],
  baseCorpusFiles?: string[]
): CitationTarget => {
  const origin = classifyCitation(citation)
  if (isHttpUrl(citation.url)) {
    return { kind: 'url', url: citation.url!, origin }
  }

  const snippet = citationSnippet(citation)
  const locator = locatorForCitation(citation)
  if (locator) {
    const wanted = locator.filename.toLowerCase()
    const storedDoc = storedDocuments?.find((doc) => doc.filename.toLowerCase() === wanted)
    if (storedDoc && isPreviewableContentType(storedDoc.contentType)) {
      return {
        kind: 'document',
        origin: 'kb',
        title: storedDoc.filename,
        page: locator.page,
        snippet,
        document: {
          type: 'stored',
          id: storedDoc.id,
          filename: storedDoc.filename,
          contentType: storedDoc.contentType ?? null,
        },
      }
    }
    const baseFile = baseCorpusFiles?.find((fileName) => fileName.toLowerCase() === wanted)
    if (baseFile) {
      return {
        kind: 'document',
        origin: 'kb',
        title: baseFile,
        page: locator.page,
        snippet,
        document: { type: 'base', fileName: baseFile },
      }
    }
    // Structured fileName present but index miss: still a document-info target
    // (exact backend locator, not client guessing).
    if (citation.fileName) {
      return {
        kind: 'info',
        origin,
        title: citation.fileName,
        snippet,
      }
    }
  }

  return {
    kind: 'info',
    origin,
    title: locator?.filename ?? citation.title ?? citationLabel(citation),
    snippet,
  }
}
