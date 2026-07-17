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
const classifyCitation = (citation: CitationSource): AnswerSourceKind => {
  const tokenMatch = citation.content?.match(ORIGIN_TOKEN_RE)
  if (tokenMatch) return TOKEN_TO_KIND[tokenMatch[1].toLowerCase()]
  if (/ris\.bka\.gv\.at/i.test(citation.url)) return 'ris'
  if (isHttpUrl(citation.url)) return 'web'
  return 'kb'
}

/** Short display label for a citation: hostname for links, else content/url. */
const citationLabel = (citation: CitationSource): string => {
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
      push({ key: `legal-${label}`, label, kind: 'ris' }, `legal-${label}`)
    }
  }

  return refs.slice(0, MAX_ANSWER_SOURCES)
}
