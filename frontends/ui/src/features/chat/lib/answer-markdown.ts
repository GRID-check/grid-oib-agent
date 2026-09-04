/**
 * The answer, as text somebody can paste somewhere else.
 *
 * An answer only exists inside Piloti until it can leave it: the reader's next
 * move is a Prüfvermerk, a mail to the Bauherr, an Einreichung. Selecting the
 * rendered block with the mouse loses exactly the parts that make it evidence —
 * the `[N]` numbering, the tables, the emphasis — so what goes on the clipboard
 * is the MARKDOWN the answer was written in, not the DOM it was rendered into.
 *
 * Two shapes, because two things are being pasted:
 *
 *  - {@link answerMarkdown} — the answer as written, sources section and all.
 *  - {@link answerMarkdownWithSources} — the same prose under a sources list
 *    written out from the turn's citation model, so a `[3]` in the pasted text
 *    still names a document, a page and a link once it is outside the app.
 *
 * Both drop the `[[card:N]]` placement markers: those are internal machinery
 * that means nothing in Word.
 *
 * Everything here is a pure function of the answer plus the citation model —
 * the model is built ONCE by the answer component and handed in, never
 * re-derived, which is the rule the citation feature exists to enforce.
 */

import {
  answerDocuments,
  bibliographyRows,
  documentPages,
  isHttpUrl,
  type CitedDocument,
} from './citations'

/** A `[[card:N]]` placement marker sitting alone on its line. */
const CARD_MARKER_LINE = /^ {0,3}\[\[card:\d+\]\][ \t]*$/
/** A `[[card:N]]` marker anywhere in a line. */
const CARD_MARKER = /\[\[card:\d+\]\]/g

/**
 * Remove the card placement markers from answer markdown.
 *
 * A marker on its own line takes the line with it (and the blank line the
 * removal would otherwise leave doubled), because that is how the agent is
 * asked to write it; a mid-sentence marker is cut out of the sentence.
 */
export const stripCardMarkers = (markdown: string): string => {
  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    if (CARD_MARKER_LINE.test(line)) continue
    const stripped = CARD_MARKER.test(line) ? line.replace(CARD_MARKER, '').trimEnd() : line
    // Two blank lines are a paragraph gap; three are a hole where a card was.
    if (stripped.trim() === '' && lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      continue
    }
    lines.push(stripped)
  }
  return lines.join('\n').trim()
}

/** The German (or English) words the written-out sources list is built from. */
export interface AnswerSourceLabels {
  /** Heading of the appended list — the label the answer itself uses ("Quellen"). */
  heading: string
  /** "S. 12" for a single cited page. */
  page: (page: number) => string
  /** "S. 5, 12, 18" for a document read at several. */
  pages: (pages: number[]) => string
  /** Stand-in for a source that carries no title at all. */
  untitled: string
}

/**
 * One source, written out: what it is called, where in it, and how to reach it.
 *
 * The locator is the URL for anything on the web and the raw filename for a
 * corpus/project document — the two things that let a reader outside Piloti
 * find the passage again. It is omitted when it would only repeat the title.
 */
const describeSource = (
  doc: CitedDocument,
  pageText: string | undefined,
  untitled: string
): string => {
  const title = doc.title?.trim() || doc.fileName?.trim() || untitled
  const fileName = doc.fileName?.trim()
  const locator = isHttpUrl(doc.url)
    ? doc.url
    : fileName && fileName !== title
      ? fileName
      : undefined

  const head = pageText ? `${title}, ${pageText}` : title
  return locator ? `${head} — ${locator}` : head
}

/** The page phrase for a document-level entry, or undefined for a whole-document hit. */
const pageTextFor = (doc: CitedDocument, labels: AnswerSourceLabels): string | undefined => {
  const pages = documentPages(doc)
  if (pages.length === 1) return labels.page(pages[0]!)
  if (pages.length > 1) return labels.pages(pages)
  return undefined
}

/**
 * The answer's sources as a markdown list, or `''` when it has none.
 *
 * Numbered entries come first and are the LOCUS-level projection — one line per
 * `[N]` in the prose, because every marker the reader pasted must lead
 * somewhere. Sources the answer leaned on without numbering them (a
 * `legal_basis` card names a law, not a passage) follow as bullets rather than
 * being given a number the prose never wrote.
 */
export const sourcesMarkdown = (
  documents: CitedDocument[],
  labels: AnswerSourceLabels
): string => {
  const docs = answerDocuments(documents)
  if (docs.length === 0) return ''

  const rows = bibliographyRows(docs)
  const numbered = rows.map(
    (row) =>
      `[${row.number}] ${describeSource(
        row.document,
        row.locus.page != null ? labels.page(row.locus.page) : undefined,
        labels.untitled
      )}`
  )

  const claimed = new Set(rows.map((row) => row.document.id))
  const rest = docs
    .filter((doc) => !claimed.has(doc.id))
    .map((doc) => `- ${describeSource(doc, pageTextFor(doc, labels), labels.untitled)}`)

  const lines = Array.from(new Set([...numbered, ...rest]))
  if (lines.length === 0) return ''
  return `## ${labels.heading}\n\n${lines.join('\n')}`
}

/** True when {@link answerMarkdownWithSources} would have anything to append. */
export const hasCopyableSources = (documents: CitedDocument[]): boolean =>
  answerDocuments(documents).length > 0

/**
 * The answer exactly as it was written — its own sources section included,
 * minus the placement markers.
 */
export const answerMarkdown = (content: string): string => stripCardMarkers(content)

/**
 * The answer's prose under a written-out sources list.
 *
 * Takes the BODY (the answer with its own written sources section already lifted
 * out by `splitAnswerBody`), so the pasted text states its sources once — the
 * resolved list, which knows titles, pages and links the written one may not.
 */
export const answerMarkdownWithSources = (
  body: string,
  documents: CitedDocument[],
  labels: AnswerSourceLabels
): string => {
  const prose = stripCardMarkers(body)
  const sources = sourcesMarkdown(documents, labels)
  if (!sources) return prose
  return prose ? `${prose}\n\n${sources}` : sources
}
