/**
 * Human display names for corpus documents.
 *
 * Raw corpus filenames (`oib-rl_2.3_ausgabe_mai_2023.pdf`) are storage
 * identity, not something a user should ever read. The backend already derives
 * a German display title at ingestion (`norm_registry.guess_display_title`,
 * stored + admin-overridable in the document_metadata store) and ships it on
 * the `Source:` line and — since the fan-out carries it — as `title` on each
 * `## Trace-Lanes` source.
 *
 * This module is the CLIENT mirror of that derivation, used as the fallback for
 * everything the wire does not label: pruned messages stored before the wire
 * carried titles, the `--- Result N ---` / URL fallback parsers, and uploads
 * that have no derived title at all (project/Büroarchiv PDFs).
 *
 * Keep {@link oibDisplayTitle} in sync with `guess_display_title` in
 * `src/aiq_agent/common/norm_registry.py` — same inputs must yield the same
 * German title on both sides, or a card's name would flip when a message is
 * reloaded from storage.
 */

/** File extensions we strip when falling back to a filename-derived name. */
const DOC_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown',
  'xls', 'xlsx', 'ods', 'csv', 'tsv',
  'ppt', 'pptx', 'odp',
  'html', 'htm', 'xml', 'json', 'eml', 'msg',
  'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff',
  'dwg', 'dxf', 'ifc', 'zip',
])

/** German role prefixes — mirror of `_OIB_TITLE_ROLE_PREFIXES`. */
const OIB_ROLE_PREFIXES: Array<[string, string]> = [
  ['erlaeuterungen_', 'Erläuterungen zu '],
  ['aenderungen_', 'Änderungen zu '],
]

const OIB_EDITION_RE = /ausgabe[_-]mai[_-]2023/
const OIB_REVISION_RE = /rev[_.]?(\d+)/
const OIB_NUMBER_RE = /^(\d+(?:\.\d+)?)/

/** Last path segment of a possibly-pathed file name. */
const baseName = (name: string): string => name.split(/[/\\]/).pop() || name

/** Split `foo.bar.pdf` into `['foo.bar', 'pdf']`; extension is `''` when absent. */
const splitExtension = (name: string): [string, string] => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot + 1).toLowerCase()]
}

/** Trim leading/trailing underscores — the JS twin of Python's `strip("_")`. */
const stripUnderscores = (value: string): string => value.replace(/^_+|_+$/g, '')

/**
 * German display title for an OIB corpus document, or `null` when the filename
 * is not a recognisable OIB corpus name (any upload, any other source).
 *
 * Mirror of `norm_registry.guess_display_title`:
 *
 *   oib-rl_2_ausgabe_mai_2023.pdf      → "OIB-Richtlinie 2, Ausgabe Mai 2023"
 *   oib-rl_6-leitfaden_…pdf            → "OIB-Richtlinie 6 – Leitfaden, Ausgabe Mai 2023"
 *   erlaeuterungen_oib-rl_2_…pdf       → "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023"
 */
export function oibDisplayTitle(fileName: string): string | null {
  if (!fileName?.trim()) return null
  const [stem] = splitExtension(baseName(fileName.trim()))
  // Normalise the one known separator inconsistency (`6-leitfaden` vs
  // `2_leitfaden`) so the rest of the parse is uniform.
  let low = stem.toLowerCase().replace('-leitfaden', '_leitfaden')

  let rolePrefix = ''
  for (const [marker, german] of OIB_ROLE_PREFIXES) {
    if (low.startsWith(marker)) {
      rolePrefix = german
      low = low.slice(marker.length)
      break
    }
  }

  if (!low.startsWith('oib-rl_')) return null
  low = low.slice('oib-rl_'.length)

  let edition = ''
  const editionMatch = OIB_EDITION_RE.exec(low)
  if (editionMatch) {
    edition = 'Ausgabe Mai 2023'
    low = stripUnderscores(low.slice(0, editionMatch.index) + low.slice(editionMatch.index + editionMatch[0].length))
  }

  let revision = ''
  const revisionMatch = OIB_REVISION_RE.exec(low)
  if (revisionMatch) {
    revision = `Rev. ${revisionMatch[1]}`
    low = stripUnderscores(low.slice(0, revisionMatch.index) + low.slice(revisionMatch.index + revisionMatch[0].length))
  }

  const isLeitfaden = low.includes('leitfaden')
  low = stripUnderscores(low.replace('leitfaden', ''))

  let subject: string
  if (low.startsWith('begriffsbestimmungen')) {
    subject = 'OIB-Richtlinie Begriffsbestimmungen'
  } else if (low.startsWith('zitierte_normen')) {
    subject = 'OIB-Richtlinie – Zitierte Normen und sonstige technische Regelwerke'
  } else if (!low) {
    subject = 'OIB-Richtlinie'
  } else {
    const numberMatch = OIB_NUMBER_RE.exec(low)
    if (!numberMatch) return null
    subject = `OIB-Richtlinie ${numberMatch[1]}`
  }
  if (isLeitfaden) subject += ' – Leitfaden'

  const title = `${rolePrefix}${subject}`
  const tail = [edition, revision].filter(Boolean).join(', ')
  return tail ? `${title}, ${tail}` : title
}

/**
 * Readable name for a plain upload: drop the extension, turn the filename's
 * separators into spaces and lift the first letter. Deliberately conservative —
 * hyphens survive (they carry meaning in `OIB-RL`, `MA-37`, `EN-1993`) and the
 * rest of the casing is left alone because German nouns are already capitalised.
 */
function humanizeFileName(fileName: string): string {
  const [stem, ext] = splitExtension(baseName(fileName.trim()))
  // Only strip a KNOWN document extension: a hostname (`ris.bka.gv.at`) or a
  // versioned name (`Konzept_v1.2`) must not lose its last segment.
  const body = ext && DOC_EXTENSIONS.has(ext) ? stem : `${stem}${ext ? `.${ext}` : ''}`
  const spaced = body
    .replace(/[_]+/g, ' ')
    .replace(/%20/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return fileName.trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * User-facing name for a document reference.
 *
 * Order: an authoritative `title` from the wire (the backend's stored/derived
 * display title) → the OIB filename derivation → a humanized filename. Already
 * human input passes through essentially unchanged, so this is safe to apply to
 * values that may or may not still be raw filenames (idempotent in practice).
 */
export function documentDisplayName(name: string, title?: string | null): string {
  const wire = title?.trim()
  if (wire) return wire
  const raw = name?.trim()
  if (!raw) return ''
  return oibDisplayTitle(raw) ?? humanizeFileName(raw)
}

/**
 * Same name with the edition/revision tail dropped — for tight card real estate
 * where "OIB-Richtlinie 2" says everything "OIB-Richtlinie 2, Ausgabe Mai 2023"
 * does. Only the trailing `, Ausgabe …` / `, Rev. …` segments are removed, so a
 * name whose comma carries content (`Bauordnung für Wien, § 108`) is untouched.
 */
export function documentShortName(name: string, title?: string | null): string {
  const full = documentDisplayName(name, title)
  const trimmed = full.replace(/,\s*(Ausgabe\s+[^,]+|Rev\.\s*[\d.]+)(?=,|$)/g, '')
  const cleaned = trimmed.replace(/,\s*$/, '').trim()
  return cleaned || full
}
