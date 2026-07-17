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
import type { CitationSource } from '../types'

/** Origin of an answer source — mirrors ReportSourceKind (kb/ris/web). */
export type AnswerSourceKind = 'kb' | 'ris' | 'web'

export interface AnswerSourceRef {
  /** Stable key for rendering */
  key: string
  /** Short human-readable label (hostname, law name, …) */
  label: string
  /** Parsed origin — drives the provenance tint */
  kind: AnswerSourceKind
  /** Outbound link, only when the citation has a real http(s) URL */
  url?: string
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
const MAX_ANSWER_SOURCES = 8

/** Leading backend origin token, e.g. "[RIS] …" (citation_verification). */
const ORIGIN_TOKEN_RE = /^\s*\[(KB|Web|RIS)\]\s*/i

const TOKEN_TO_KIND: Record<string, AnswerSourceKind> = {
  kb: 'kb',
  web: 'web',
  ris: 'ris',
}

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

/** Classify a single citation into an origin kind (token first, then URL). */
const classifyCitation = (citation: Pick<CitationSource, 'url' | 'content'>): AnswerSourceKind => {
  const tokenMatch = citation.content?.match(ORIGIN_TOKEN_RE)
  if (tokenMatch) return TOKEN_TO_KIND[tokenMatch[1].toLowerCase()]
  if (/ris\.bka\.gv\.at/i.test(citation.url)) return 'ris'
  if (isHttpUrl(citation.url)) return 'web'
  return 'kb'
}

/** Short display label for a citation: hostname for links, else content/url. */
const citationLabel = (citation: Pick<CitationSource, 'url' | 'content'>): string => {
  if (isHttpUrl(citation.url)) {
    const host = hostnameOf(citation.url)
    if (host) return host
  }
  const text = (citation.content ?? '').replace(ORIGIN_TOKEN_RE, '').trim()
  const firstLine = text.split('\n')[0]?.trim()
  const base = firstLine || citation.url
  return base.length > 48 ? `${base.slice(0, 47)}…` : base
}

/**
 * Derive the provenance chips for one agent response from data that already
 * exists on the message. Deduplicates by url/label and caps the row length.
 */
export const deriveAnswerSources = (
  citations?: CitationSource[],
  cards?: GridCard[]
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
      push(
        {
          key: `citation-${citation.id || citation.url}`,
          label: citationLabel(citation),
          kind,
          url: isHttpUrl(citation.url) ? citation.url : undefined,
          citation,
        },
        citation.url || citationLabel(citation)
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
      push({ key: `legal-${label}`, label, kind: 'ris', snippet }, `legal-${label}`)
    }
  }

  return refs.slice(0, MAX_ANSWER_SOURCES)
}

// ---------------------------------------------------------------------------
// WS-9 — citation → preview-target resolution (spec §6 WS-9, backlog FB-4)
// ---------------------------------------------------------------------------

/**
 * The minimal shape of a project document a citation can resolve against.
 * Matches what `GET /api/documents?projectId=…` returns (DocumentListRow).
 */
export interface ProjectDocumentRef {
  id: string
  filename: string
  contentType?: string | null
}

/**
 * Where a clicked citation chip can take the user:
 *  - `url`      — a real outbound link (Web / RIS): keep linking out.
 *  - `document` — an in-app document preview, either a project upload
 *                 (presigned preview via /api/documents/{id}/preview) or a
 *                 base-corpus PDF (/api/knowledge-base/documents/{fileName}).
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
        | { type: 'project'; id: string; filename: string; contentType: string | null }
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

/** Locator from a citation: content first, then a pseudo-URL basename. */
const locatorForCitation = (
  citation: Pick<CitationSource, 'url' | 'content'>
): KbCitationLocator | null => {
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
  if (!text || text === citation.url.trim()) return undefined
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
 *     exact filename) against the project's documents, then the base corpus.
 *     Project matches must be inline-previewable (PDF/image) — anything else
 *     degrades to `info` rather than opening a viewer that cannot render.
 *  3. Anything unresolvable becomes an `info` target (title/origin/snippet).
 *
 * `projectDocuments` / `baseCorpusFiles` are optional: without them (lists not
 * loaded, or the caller cannot fetch), resolution honestly degrades to `info`.
 */
export const resolveCitationTarget = (
  citation: Pick<CitationSource, 'url' | 'content'>,
  projectDocuments?: ProjectDocumentRef[],
  baseCorpusFiles?: string[]
): CitationTarget => {
  const origin = classifyCitation(citation)
  if (isHttpUrl(citation.url)) {
    return { kind: 'url', url: citation.url, origin }
  }

  const snippet = citationSnippet(citation)
  const locator = locatorForCitation(citation)
  if (locator) {
    const wanted = locator.filename.toLowerCase()
    const projectDoc = projectDocuments?.find((doc) => doc.filename.toLowerCase() === wanted)
    if (projectDoc && isPreviewableContentType(projectDoc.contentType)) {
      return {
        kind: 'document',
        origin: 'kb',
        title: projectDoc.filename,
        page: locator.page,
        snippet,
        document: {
          type: 'project',
          id: projectDoc.id,
          filename: projectDoc.filename,
          contentType: projectDoc.contentType ?? null,
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
  }

  return {
    kind: 'info',
    origin,
    title: locator?.filename ?? citationLabel(citation),
    snippet,
  }
}
