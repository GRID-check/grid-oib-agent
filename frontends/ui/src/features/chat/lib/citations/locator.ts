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

import { CITATION_KEY_QUALIFIERS, scopeForQualifier, type Shelf } from '../source-kinds'
import { stripOriginToken } from './model'

/** A knowledge-layer citation locator: filename + optional page + optional shelf. */
export interface KbCitationLocator {
  filename: string
  page?: number
  /**
   * Shelf named by the key's `(Projektwissen)` qualifier, when it carries one.
   *
   * A payload carrying the shelf as data (ADR-0047) always wins; this is the
   * fallback for messages persisted before that field existed, and the reading
   * for keys the backend still qualifies today to keep one filename unique
   * across two shelves.
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
 * Trailing qualifier of a citation key (`Plan.pdf (Projektwissen)`) — mirrors
 * the backend's `_SCOPE_QUALIFIER_RE`.
 *
 * Only qualifiers a WRITER can emit match, so a parenthetical that is genuinely
 * part of a filename ("Bescheid (Kopie).pdf") is never mistaken for one, and a
 * display label reworded on the rendering side cannot start eating filenames.
 *
 * That set is four, not the legacy three: the backend still appends a qualifier
 * to keep a key unique when two retrieved files share a name across shelves, so
 * it writes `(Private Sitzung)` for a session hit. A reader that knew only the
 * legacy three left the qualifier in place, the remainder missed `FILENAME_RE`,
 * and the citation resolved to null.
 */
const SCOPE_QUALIFIER_RE = new RegExp(
  `\\s*\\((${CITATION_KEY_QUALIFIERS.map(([label]) =>
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
