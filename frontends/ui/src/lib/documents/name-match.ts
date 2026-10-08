/**
 * When two filenames are THE SAME document, and when they are merely the same
 * document to a person.
 *
 * A project identifies a document by its filename (migration 0074): the unique
 * index, the ingest pipeline's replace-by-name, and the folder-upload planner
 * all turn on string equality between the name on the row and the name of the
 * file somebody just picked. That equality was raw, and raw string equality is
 * the wrong test for a filename:
 *
 *   - **Unicode form.** macOS stores names decomposed, so an umlaut in a name
 *     dragged off a Mac is `u` followed by a combining diaeresis (NFD) where the
 *     same name typed into Piloti — or arriving from Windows — is the single
 *     precomposed codepoint (NFC). They render identically, they are different
 *     strings, and every German filename in this product is a candidate.
 *     `folderMatchKey` already normalized this for FOLDERS, which is what made
 *     a re-synced Einreichung match its folder and then report every single
 *     file inside it as new.
 *   - **Trailing whitespace**, which a file manager will happily produce and
 *     nobody can see.
 *
 * ## Two keys, because they answer two different questions
 *
 * {@link documentNameKey} is IDENTITY: the form a filename is stored and
 * compared in. Two names with this key equal are one document, and a re-upload
 * of one replaces the other. It deliberately does NOT fold case, because
 * Postgres does not either: `Plan.pdf` and `plan.pdf` are two rows, and a
 * planner that promised to update one while the server inserted the other would
 * be lying about what is going to happen.
 *
 * {@link documentAliasKey} is RECOGNITION: "the reader means the one that is
 * already here". Case-folded, and computed over every name a document carries —
 * its filename, the name somebody renamed it to, and the name the file had on
 * disk when it was first uploaded. A match here is not an identity, so it can
 * never drive a replace; it is what lets the upload plan say «this is already
 * in the project, under another name» instead of quietly adding a second copy.
 */

/**
 * The comparable, storable form of a filename — NFC, without surrounding
 * whitespace.
 *
 * Applied at admission (so every row written from now on is in one form) and
 * before every comparison (so rows written before it are still found).
 */
export function documentNameKey(name: string): string {
  return name.normalize('NFC').trim()
}

/**
 * Both Unicode forms of a name.
 *
 * For the one lookup that cannot normalize the column it is querying: rows
 * written before this module exists may hold either form, and `WHERE filename =
 * $1` finds only one of them. Two exact candidates keep the index in play,
 * which `normalize(filename, NFC) = $1` would not, and cost nothing on the
 * overwhelmingly common case where the two forms are the same string.
 */
export function documentNameVariants(name: string): string[] {
  const key = documentNameKey(name)
  const decomposed = key.normalize('NFD')
  return decomposed === key ? [key] : [key, decomposed]
}

/**
 * The looser key: one document to a person, two rows to Postgres.
 *
 * Never an identity — see the module header. Used only to RECOGNIZE, and every
 * caller has to be able to say what it recognized and let a person decide.
 */
export function documentAliasKey(name: string): string {
  return documentNameKey(name).toLowerCase()
}

/**
 * The filename out of a path, for the `origin_path` a folder upload recorded.
 *
 * Returns null for an empty path and for a path whose last segment is empty,
 * so a caller can key a map on the result without inventing an entry for "".
 */
export function originBaseName(path: string | null | undefined): string | null {
  if (!path) return null
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : null
}
