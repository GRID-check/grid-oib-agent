/**
 * What a document is CALLED, and what may be typed into the rename field.
 *
 * A pure module on purpose, and deliberately not `server-only`: the same rules
 * have to hold in the rename dialog (which must refuse a bad name before it is
 * sent, and say why) and in the service that persists it (which cannot trust
 * anything the dialog decided). Two implementations of "is this a valid name"
 * would disagree the first time either changed, and the one that mattered
 * would be the one nobody could see.
 *
 * The split it enforces: `filename` is the document's IDENTITY — the key to its
 * stored object and to its chunks in the retrieval index — and `displayName` is
 * its LABEL. Renaming writes the label. See migration 0046 for why editing the
 * identity is not on offer.
 */

/**
 * Longest name a rename may set.
 *
 * Not a storage limit (the column is `text`): it is the point past which a name
 * has stopped being a name. The audit trail already caps what it records at 200
 * characters, the file list truncates well before this, and a document called a
 * paragraph is a document nobody can find in a list.
 */
export const MAX_DOCUMENT_NAME_LENGTH = 200

/** The two fields every surface needs to show a document's name. */
export interface NamedDocument {
  filename: string
  displayName?: string | null
}

/**
 * The name to SHOW for a document.
 *
 * One function rather than `displayName ?? filename` spelled out at each call
 * site: a blank-but-present value (an empty string that survived a bad write,
 * or whitespace) has to fall back too, and that is exactly the kind of detail
 * that gets written correctly in four places and forgotten in the fifth.
 */
export function documentDisplayName(document: NamedDocument): string {
  const renamed = document.displayName?.trim()
  return renamed ? renamed : document.filename
}

/**
 * A name split at its extension — `Grundriss EG.ifc` → `Grundriss EG` + `.ifc`.
 *
 * The extension is what the bytes ARE, so the rename field edits the stem and
 * puts the extension back afterwards (the same thing Finder and Explorer do
 * when they preselect only the stem). A reader who renames `Plan.pdf` to
 * `Einreichplan` gets `Einreichplan.pdf` and not a PDF called `Einreichplan`
 * that every list then draws with no format chip.
 *
 * A dotfile (`.gitignore`) and a name with no dot at all are both all-stem —
 * there is no extension to protect in either case.
 */
export function splitDocumentName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension: name.slice(dot) }
}

/** Why a typed name cannot be used. Each maps to one sentence in the dialog. */
export type DocumentNameError = 'empty' | 'tooLong' | 'invalidCharacters'

export type DocumentNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: DocumentNameError }

/**
 * Path separators and control characters.
 *
 * `display_name` never reaches a filesystem — the stored object keeps its own
 * key — so this is not path-traversal defence; it is the plainer rule that a
 * name containing a slash or a newline is not a name. It would render as one
 * line in a list, sort strangely, and read as a folder path that does not
 * exist. The control range covers the newline that a paste out of a PDF
 * brings with it, which is how this actually happens.
 */
// eslint-disable-next-line no-control-regex -- catching control characters is the point
const INVALID_NAME_CHARACTERS = /[/\\\u0000-\u001f\u007f]/

/**
 * Normalize and check a name typed by a user.
 *
 * Trimming is part of normalization rather than a rejection: a trailing space
 * from a paste is not a mistake worth refusing, it is one worth silently
 * fixing. Everything else is refused with a reason, because a rename that
 * quietly stores something other than what was typed is worse than one that
 * explains itself.
 */
export function validateDocumentName(input: string): DocumentNameResult {
  const value = input.trim()
  if (value === '') return { ok: false, reason: 'empty' }
  if (value.length > MAX_DOCUMENT_NAME_LENGTH) return { ok: false, reason: 'tooLong' }
  if (INVALID_NAME_CHARACTERS.test(value)) return { ok: false, reason: 'invalidCharacters' }
  return { ok: true, value }
}

/**
 * The full name a rename should persist, given the edited stem and the name it
 * started from.
 *
 * The extension comes from the ORIGINAL name, so it survives however the stem
 * is edited — including a stem someone typed the extension into again
 * (`Einreichplan.pdf` for a `.pdf`), which would otherwise produce
 * `Einreichplan.pdf.pdf`. Case-insensitive, because `.PDF` and `.pdf` are the
 * same claim about the bytes.
 */
export function composeDocumentName(stem: string, originalName: string): string {
  const { extension } = splitDocumentName(originalName)
  const trimmed = stem.trim()
  if (extension === '') return trimmed
  return trimmed.toLowerCase().endsWith(extension.toLowerCase()) ? trimmed : `${trimmed}${extension}`
}
