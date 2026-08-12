/**
 * Citation-key parsing — the (document, locus) split, read off a key.
 *
 * A knowledge-layer citation key is the backend's compact spelling of exactly
 * the two levels this feature models: `Plan.pdf (Projektwissen), p.3` names a
 * DOCUMENT (`Plan.pdf` on the Projektwissen shelf) and a LOCUS within it
 * (page 3). Parsing it is therefore a model concern, not a rendering one.
 *
 * Every regex here mirrors a backend counterpart in `citation_verification.py`;
 * the pairs are pinned by `tests/fixtures/citation_pipeline/` through
 * `citation-wire-contract.spec.ts`.
 */

import { LEGACY_SCOPE_QUALIFIERS, scopeForQualifier, type Shelf } from '../source-kinds'
import { stripOriginToken } from './model'

/** A knowledge-layer citation locator: filename + optional page + optional shelf. */
export interface KbCitationLocator {
  filename: string
  page?: number
  /**
   * Shelf named by a LEGACY key's `(Projektwissen)` qualifier, when it carries
   * one. New payloads carry the shelf as data (ADR-0047) and a reader must
   * prefer that field; this is only how keys already persisted in messages
   * still name their shelf.
   */
  shelf?: Shelf
}

/**
 * Page token of a KB citation key — mirrors the backend's `_PAGE_RE`: the token
 * must be a separate word so filenames containing "p"+digits ("Top2.pdf") are
 * never truncated into bogus pages.
 */
const PAGE_REF_RE = /[,\s]\s*(?:p\.?|page)\s*(\d+)(?=\s*(?:[,)\]]|$))/i

/** A plausible filename (mirrors the backend's `_KL_CITATION_PATTERN_RE`). */
const FILENAME_RE = /^.+\.\w{2,5}$/

/**
 * Trailing qualifier of a LEGACY citation key (`Plan.pdf (Projektwissen)`) —
 * mirrors the backend's `_SCOPE_QUALIFIER_RE`. Only the three qualifiers the
 * legacy writer could emit match, so a parenthetical that is genuinely part of
 * a filename ("Bescheid (Kopie).pdf") is never mistaken for one — and a display
 * label renamed on the rendering side cannot start eating filenames.
 */
const SCOPE_QUALIFIER_RE = new RegExp(
  `\\s*\\((${LEGACY_SCOPE_QUALIFIERS.map(([label]) =>
    label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})\\)\\s*$`,
  'i'
)

/** Pseudo-URL scheme prefix (kb://…, doc://…) sometimes carried by citations. */
const PSEUDO_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Parse a knowledge-layer locator ("Brandschutzkonzept.pdf, p.3") out of a
 * free-text citation line. Returns null when the text does not look like a
 * document reference. Mirrors the backend's `_parse_citation_key`.
 */
export const parseKbLocator = (text: string): KbCitationLocator | null => {
  const line = stripOriginToken(text).split('\n')[0]?.trim() ?? ''
  if (!line) return null
  const pageMatch = PAGE_REF_RE.exec(line)
  const page = pageMatch ? Number(pageMatch[1]) : undefined
  let filename = (pageMatch ? line.slice(0, pageMatch.index) : line).replace(/[\s,]+$/, '').trim()
  const qualifierMatch = SCOPE_QUALIFIER_RE.exec(filename)
  const shelf = qualifierMatch ? scopeForQualifier(qualifierMatch[1]) : undefined
  if (qualifierMatch) {
    filename = filename.slice(0, qualifierMatch.index).replace(/[\s,]+$/, '').trim()
  }
  if (!FILENAME_RE.test(filename)) return null
  return { filename, page, shelf }
}

/** Filename carried by a pseudo-URL (`kb://corpus/Plan.pdf`), if any. */
export const locatorFromPseudoUrl = (url: string): KbCitationLocator | null => {
  const basename = url.replace(PSEUDO_SCHEME_RE, '').split('/').pop() ?? ''
  try {
    return parseKbLocator(decodeURIComponent(basename))
  } catch {
    return parseKbLocator(basename)
  }
}
