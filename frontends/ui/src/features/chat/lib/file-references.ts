/**
 * The filenames an answer writes into its prose, made openable.
 *
 * An answer that says „Beginnen Sie mit pd8280-2.pdf, danach der
 * Brandschutzvorprüfung" has named a real file the reader owns, and until now
 * that name was dead text: the way to act on it was Dateien, the search box,
 * the name typed back in, and a scroll. The `[N]` citation machinery does not
 * help here — a file reference is not a citation. It carries no page, no
 * passage and no claim; it is the model saying WHICH DOCUMENT, usually about
 * one it did not cite at all (a plan it is recommending you read next, a
 * Bestandsunterlage it is telling you is missing).
 *
 * ## Why this does not guess at filename grammar
 *
 * The obvious implementation is a regex for "word-ish characters, a dot, a
 * known extension". It fails on both sides. `Wien Lacknergasse Grundrisse.pdf`
 * has spaces, so the pattern either misses it or — made greedy enough to catch
 * it — swallows the sentence in front of it. And a name it invents
 * (`Konzept.pdf`, in a project holding no such file) becomes a control that
 * leads nowhere, which the citation marker already establishes is worse than
 * plain text.
 *
 * So there is no grammar. The set of things that can be a file reference is
 * exactly the set of filenames the reader actually has, and matching is
 * literal. {@link fileNamesPresentIn} takes the index and finds which of its
 * names the body names; nothing is linked that cannot be opened.
 *
 * The index is not free (three list fetches), so {@link mentionsAnyFileType} is
 * the cheap gate in front of it: an answer with no document extension anywhere
 * in it cannot name a file, and most answers do not.
 */

/**
 * Fragment prefix for a file reference, chosen to be distinguishable from the
 * answer's citation anchors (`answer-source-<messageId>-<N>`), which are
 * per-message and numeric. This one carries the NAME, so a chip resolves
 * without an index into a list that streaming is still growing.
 */
export const FILE_REFERENCE_ANCHOR_PREFIX = 'file-ref-'

/**
 * Extensions worth stopping on. Deliberately the formats a practice actually
 * files and talks about — not every extension the storage layer accepts — so
 * the gate below stays a strong signal rather than firing on a hostname or a
 * version number.
 */
const FILE_TYPE_RE =
  /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|tsv|pptx?|odp|png|jpe?g|webp|tiff?|gif|svg|dwg|dxf|ifc|ifczip|zip|eml|msg)\b/i

/**
 * Could this body name a file at all? A synchronous, allocation-free question
 * asked of every answer, so the index fetch below happens only for the answers
 * that could possibly use it.
 */
export const mentionsAnyFileType = (markdown: string): boolean => FILE_TYPE_RE.test(markdown)

/**
 * Which of `fileNames` the body actually writes out, case-insensitively.
 *
 * A plain substring test rather than a tokenized one: this is a PRE-FILTER
 * whose only job is to get the candidate list down from "every document in the
 * project" to "the handful this answer could be talking about". The boundary
 * rules that decide whether an occurrence is really a reference — that
 * `xpd8280-2.pdf` does not contain a reference to `pd8280-2.pdf` — belong to
 * the marker plugin, which is looking at parsed text rather than at raw
 * markdown and can apply them without guessing.
 *
 * Returned longest-first, which is the order the plugin needs: given both
 * `Plan.pdf` and `Grundriss Plan.pdf`, the longer name is the one the reader
 * wrote.
 */
export const fileNamesPresentIn = (
  markdown: string,
  fileNames: Iterable<string>
): string[] => {
  const haystack = markdown.toLowerCase()
  const found: string[] = []
  const seen = new Set<string>()
  for (const name of fileNames) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    if (!haystack.includes(key)) continue
    seen.add(key)
    found.push(trimmed)
  }
  return found.sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/**
 * The fragment href a file reference travels as.
 *
 * A fragment rather than a route because that is the one thing markdown can
 * carry that never leaves the page: `InPageAnchorProvider` already owns `#…`
 * hrefs in this renderer, so a file reference reaches the chat's chip through
 * the same door citations do, and a surface with no provider renders it as an
 * ordinary anchor rather than navigating somewhere wrong.
 */
export const fileReferenceHref = (fileName: string): string =>
  `#${FILE_REFERENCE_ANCHOR_PREFIX}${encodeURIComponent(fileName)}`

/** The filename in a `#file-ref-…` href, or null for any other anchor. */
export const fileNameFromHref = (href: string): string | null => {
  const id = href.startsWith('#') ? href.slice(1) : href
  if (!id.startsWith(FILE_REFERENCE_ANCHOR_PREFIX)) return null
  const encoded = id.slice(FILE_REFERENCE_ANCHOR_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded) || null
  } catch {
    // A mangled escape sequence is a link something rewrote in transit, not a
    // reason to fail the render.
    return null
  }
}
