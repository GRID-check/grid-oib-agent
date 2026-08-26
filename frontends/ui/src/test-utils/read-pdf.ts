/**
 * A PDF reader for tests, deliberately independent of `@react-pdf/renderer`.
 *
 * The same argument `read-zip.ts` makes about the .docx writer: a renderer is
 * only correct if something that does not share its code can read what it
 * produced. Asserting on the react-pdf element tree proves that a `<Text>` was
 * described — never that the words survived layout, font encoding and stream
 * compression into a file a reader can open. That gap is not theoretical for
 * this repo's German copy: „KI-generiert — nicht geprüft" is an em dash and two
 * umlauts, and a font or encoding that cannot carry them fails by dropping
 * characters, not by throwing.
 *
 * So this parses the bytes with pdf.js — the same parser the app's own document
 * viewer uses (`features/knowledge/lib/pdfjs-runtime.ts`), reached directly
 * because a test has no bundler to stage worker assets for.
 */

/** What a spec can ask about a rendered PDF. */
export interface PdfContents {
  /** The Info dictionary: Title, Author, Subject, Keywords, Creator, Producer. */
  info: Record<string, unknown>
  pageCount: number
  /**
   * Every page's text, in reading order, whitespace-normalised.
   *
   * Normalised because pdf.js reports one item per laid-out LINE (and one per
   * styled run within it), so a wrapped sentence arrives as fragments with no
   * spaces of their own. Joining on a single space and collapsing runs of
   * whitespace reconstructs what a person reads — which is what an assertion
   * about a printed notice is actually about.
   */
  text: string
}

/** Collapse the whitespace of an expected string the same way {@link readPdf} does. */
export const normalizePdfText = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * pdf.js types the Info dictionary as bare `Object` — it is whatever keys the
 * file happened to carry — so it is narrowed with a guard rather than asserted.
 * A file with no Info dictionary is a real outcome and worth a loud failure.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export async function readPdf(bytes: Uint8Array): Promise<PdfContents> {
  // The LEGACY build, for the reason `pdfjs-runtime.ts` gives: the modern one
  // calls `Map.prototype.getOrInsertComputed`, which is not in every V8 this
  // suite runs on.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // The LOADING TASK is what owns the worker and what has `destroy()`; the
  // document proxy does not (pdf.js 6). Holding it is the difference between a
  // spec file that finishes and one that leaves a worker alive per assertion.
  const task = pdfjs.getDocument({
    data: bytes,
    // No system font probing: a test process has no font book, and asking for
    // one turns a parse into a filesystem sweep.
    useSystemFonts: false,
    // The base-14 replacements, read straight out of the package. react-pdf
    // writes Helvetica without embedding it, so without this pdf.js logs
    // "Ensure that the `standardFontDataUrl` API parameter is provided" once
    // per page and falls back — which both floods the suite's stderr and
    // leaves the extracted text depending on a fallback rather than on the
    // metrics the file actually names. The app stages the same files under
    // `public/pdfjs/` (`scripts/copy-pdfjs-assets.mjs`); a spec has no server
    // to serve them from, so it reads them from `node_modules` directly.
    // pdf.js 6 rejects a factory URL that does not end in `/`. `fileURLToPath`
    // on Windows yields `...\standard_fonts\` — a trailing backslash, which
    // fails that check. The `file:` URL keeps the slash on every OS.
    standardFontDataUrl: new URL(
      '../../node_modules/pdfjs-dist/standard_fonts/',
      import.meta.url,
    ).href,
  })
  const document = await task.promise

  const pageCount = document.numPages
  const pages: string[] = []
  for (let number = 1; number <= pageCount; number += 1) {
    const page = await document.getPage(number)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }

  const { info } = await document.getMetadata()
  await task.destroy()

  if (!isRecord(info)) throw new Error('the PDF carries no information dictionary')

  return { info, pageCount, text: normalizePdfText(pages.join(' ')) }
}
