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
 * `Plan.pdf` numbered: `Plan (2).pdf`. `n` of 1 is the name itself.
 *
 * The number goes before the LAST extension, so the file still opens as what
 * it is; a name without one (`README`, or `.env`, whose dot starts the name)
 * takes it at the end.
 */
export function numberedDocumentName(name: string, n: number): string {
  const key = documentNameKey(name)
  if (n <= 1) return key
  const dot = key.lastIndexOf('.')
  const stem = dot > 0 ? key.slice(0, dot) : key
  const extension = dot > 0 ? key.slice(dot) : ''
  return `${stem} (${n})${extension}`
}

/**
 * Every name a new document called `name` may take, in order: the name itself,
 * then `Name (2).ext`, `Name (3).ext` …, each in {@link documentNameKey} form.
 * Bounded, so a caller probing a store cannot loop without end.
 */
export function* documentNameCandidates(name: string, limit = 1000): Generator<string> {
  for (let n = 1; n <= limit; n += 1) yield numberedDocumentName(name, n)
}

/**
 * The first of {@link documentNameCandidates} that `isTaken` does not claim.
 *
 * `isTaken` is asked about IDENTITY keys, so `Plan.pdf` and `plan.pdf` are two
 * names, exactly as the live-name index sees them. Throws when every candidate
 * up to `limit` is taken.
 */
export function firstFreeDocumentName(
  name: string,
  isTaken: (key: string) => boolean,
  limit = 1000
): string {
  for (const candidate of documentNameCandidates(name, limit)) {
    if (!isTaken(candidate)) return candidate
  }
  throw new Error(`No free document name within ${limit} candidates`)
}

/**
 * A batch of names made distinct, in one pass: the second `Plan.pdf` becomes
 * `Plan (2).pdf`, the third `Plan (3).pdf`, and a name already numbered in the
 * batch is skipped over rather than reused.
 *
 * Linear in the batch: each base name remembers the next number it tried, so
 * a hundred copies of one name cost a hundred steps, not five thousand.
 */
export function distinctDocumentNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  const nextNumber = new Map<string, number>()
  return names.map((name) => {
    const base = documentNameKey(name)
    let n = nextNumber.get(base) ?? 1
    let candidate = numberedDocumentName(base, n)
    while (taken.has(candidate)) {
      n += 1
      candidate = numberedDocumentName(base, n)
    }
    nextNumber.set(base, n + 1)
    taken.add(candidate)
    return candidate
  })
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
