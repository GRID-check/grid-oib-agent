/**
 * The Fassung facts of a document, as the UI reads them (CONTEXT.md, „Fassung").
 *
 * A Fassung is one state of a document; a later one replaces an earlier one as
 * the basis. Across different file names the backend stores the link the way a
 * person confirmed it (`superseded_by` / `supersedes`), Piloti's own suggestion
 * (`revision_suggestion`) and what changed against the Fassung it replaces
 * (`change_summary`, `change_basis`). The backend speaks in FILE NAMES, because
 * that is all its index knows; the UI wants documents it can open.
 *
 * Two shapes live here, so that the name never travels to the browser by
 * accident:
 *
 *   - {@link FassungNames}: what the backend said, parsed defensively
 *     (`parseFassungNames`). Server-side only; nothing that leaves the BFF
 *     carries it.
 *   - {@link FassungFacts}: the same facts after every name was resolved to a
 *     document THE READER MAY SEE (`resolveFassungFacts`). A reference the
 *     reader cannot see (held under ADR-0086, in a folder closed to them under
 *     ADR-0087, archived, deleted) is dropped whole; its name is never part of
 *     the result. A name is a fact about a document (a held upload's name can
 *     say what it is), so "dropped" means the string is gone, not hidden.
 *
 * No server-only import: the features layer imports the types, and the specs
 * run the resolution on plain fixtures.
 */

/** A document the reader can open: its id and the file name it is stored under. */
export interface FassungRef {
  id: string
  filename: string
}

export interface FassungFacts {
  /** The newer document that replaces this one (a person confirmed it). */
  supersededBy: FassungRef | null
  /** The older documents this one replaces. */
  supersedes: FassungRef[]
  /** Piloti's suggestion that THIS document is a newer Fassung of `of`; nobody has confirmed it. */
  suggestion: { of: FassungRef; confidence: number; reason: string; basis: 'name' | 'content' } | null
  /** What changed against the Fassung it replaces; `'previous'` is the earlier upload under this very name. */
  changeSummary: { text: string; basis: FassungRef | 'previous' } | null
}

/** A document with nothing to say about its Fassungen; what a client holds after an unlink. */
export const EMPTY_FASSUNG: FassungFacts = { supersededBy: null, supersedes: [], suggestion: null, changeSummary: null }

/** The bounds of what the backend may hand a card; anything longer is cut, never trusted. */
export const FASSUNG_MAX_NAME_LENGTH = 255
export const FASSUNG_MAX_REFS = 20
export const FASSUNG_MAX_REASON_LENGTH = 400
export const FASSUNG_MAX_SUMMARY_LENGTH = 2000

/** What the backend said about one file, with file names where the UI will have documents. */
export interface FassungNames {
  supersededBy: string | null
  supersedes: string[]
  suggestion: { of: string; confidence: number; reason: string; basis: 'name' | 'content' } | null
  change: { text: string; basis: string | null } | null
}

/** The per-file entry fields {@link parseFassungNames} reads (top level, beside `topics` and `capture`). */
export interface RawFassungFields {
  superseded_by?: unknown
  supersedes?: unknown
  revision_suggestion?: unknown
  change_summary?: unknown
  change_basis?: unknown
}

const asName = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= FASSUNG_MAX_NAME_LENGTH ? value : null

const asText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text.slice(0, max) : null
}

const asConfidence = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

function parseSuggestion(raw: unknown): FassungNames['suggestion'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  const of = asName(fields.of)
  const confidence = asConfidence(fields.confidence)
  const basis = fields.basis
  if (of === null || confidence === null || (basis !== 'name' && basis !== 'content')) return null
  return { of, confidence, reason: asText(fields.reason, FASSUNG_MAX_REASON_LENGTH) ?? '', basis }
}

/**
 * Read a backend file entry's Fassung fields, or `null` when nothing usable is
 * left. Junk is dropped field by field: a malformed suggestion does not cost a
 * confirmed link, and a suggestion without a usable name or basis is no
 * suggestion at all.
 */
export function parseFassungNames(raw: RawFassungFields): FassungNames | null {
  const supersedes = Array.isArray(raw.supersedes)
    ? [...new Set(raw.supersedes.map(asName).filter((name): name is string => name !== null))].slice(
        0,
        FASSUNG_MAX_REFS,
      )
    : []
  const changeText = asText(raw.change_summary, FASSUNG_MAX_SUMMARY_LENGTH)

  const names: FassungNames = {
    supersededBy: asName(raw.superseded_by),
    supersedes,
    suggestion: parseSuggestion(raw.revision_suggestion),
    change: changeText === null ? null : { text: changeText, basis: asName(raw.change_basis) },
  }
  const empty =
    names.supersededBy === null && supersedes.length === 0 && names.suggestion === null && names.change === null
  return empty ? null : names
}

/** Every file name `names` refers to other than the document's own: what has to be resolved. */
export function referencedNames(names: FassungNames, ownName: string): string[] {
  const all = [
    names.supersededBy,
    ...names.supersedes,
    names.suggestion?.of ?? null,
    names.change?.basis ?? null,
  ]
  return [...new Set(all.filter((name): name is string => name !== null && name !== ownName))]
}

/**
 * Turn the backend's names into documents the reader may open.
 *
 * `lookup` answers only for documents the reader may see: same collection,
 * active, screened, in a folder open to them. It answers `null` for everything
 * else, and this function drops what it cannot resolve:
 *
 *   - a link or suggestion to an unresolvable document disappears;
 *   - a change summary against an unresolvable document disappears too. The
 *     sentence says what the other document held, so keeping the text while
 *     hiding the name would still hand over what the reader may not read;
 *   - a reference to the document itself is no link, and as a change basis it
 *     means the earlier upload under this name (`'previous'`).
 */
export function resolveFassungFacts(
  names: FassungNames | null,
  ownName: string,
  lookup: (filename: string) => FassungRef | null,
): FassungFacts | null {
  if (!names) return null
  const resolve = (filename: string | null): FassungRef | null =>
    filename === null || filename === ownName ? null : lookup(filename)

  const supersededBy = resolve(names.supersededBy)

  const seen = new Set<string>()
  const supersedes: FassungRef[] = []
  for (const filename of names.supersedes) {
    const ref = resolve(filename)
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id)
      supersedes.push(ref)
    }
  }

  const suggestedOf = names.suggestion ? resolve(names.suggestion.of) : null
  const suggestion =
    names.suggestion && suggestedOf
      ? { of: suggestedOf, confidence: names.suggestion.confidence, reason: names.suggestion.reason, basis: names.suggestion.basis }
      : null

  let changeSummary: FassungFacts['changeSummary'] = null
  if (names.change) {
    const { text, basis } = names.change
    if (basis === null || basis === ownName) {
      changeSummary = { text, basis: 'previous' }
    } else {
      const ref = lookup(basis)
      if (ref) changeSummary = { text, basis: ref }
    }
  }

  if (!supersededBy && supersedes.length === 0 && !suggestion && !changeSummary) return null
  return { supersededBy, supersedes, suggestion, changeSummary }
}
