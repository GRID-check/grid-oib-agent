/**
 * One saved answer, assembled into a document.
 *
 * Pure: it takes the facts already read out of the database and returns blocks.
 * Nothing here queries, authorizes or renders XML, which is what lets the shape
 * of the exported document be asserted directly in a spec instead of by
 * unzipping a package.
 *
 * ## The rule the whole module is built around
 *
 * **A field the stored answer does not have produces no section.** No "Projekt:
 * —", no empty Quellen heading, no placeholder date. An exported document is
 * read away from the app by someone who cannot check it against anything, so a
 * blank the reader might mistake for a fact is worse than a document that is
 * one section shorter. Every conditional below is that rule, applied once per
 * section.
 */

import type { Translator } from '@/i18n/translate'
import type { Locale } from '@/i18n/config'
import { compact, labelled, type DocBlock, type DocRun } from './blocks'
import { cardsBlocks } from './cards'
import { referencesFromStored, splitProse, type ReferenceEntry } from './citations'
import { markdownToBlocks } from './markdown'

/** The answer's confidence self-assessment (ADR-0037), as stored on the message. */
export interface AnswerConfidence {
  level: 'low' | 'medium' | 'high'
  /** The model's own one-clause justification, quoted verbatim. */
  reason?: string
  cappedReason?: 'ungrounded' | 'quote_unverified'
}

export interface AnswerDocumentInput {
  /** The conversation's title — the document's own heading when it has one. */
  conversationTitle?: string | null
  /** The project the conversation belongs to; absent for an unfiled chat. */
  projectName?: string | null
  /** The question that produced this answer (the preceding user message). */
  question?: string | null
  /** The answer's prose, as markdown. */
  answer: string
  /**
   * When the answer was written — never "now", and absent rather than guessed.
   * A caller that does not know the instant (an export assembled from a report
   * the client is holding, rather than from a stored message) must leave this
   * out: the honesty rule above applies to the date more than to anything else,
   * because a wrong date on a project document is the error nobody catches.
   */
  createdAt?: Date | null
  /** `metadata.citations`, in the stored wire shape. */
  citations?: unknown
  /** `metadata.cards`, in the stored card shape. */
  cards?: unknown
  confidence?: AnswerConfidence | null
  /**
   * Set when Piloti wrote the content and no human has reviewed it.
   *
   * Off by default, and the default is the honest one: an answer a person
   * asked for, read on screen and chose to export is not unreviewed. Marking
   * every export would make the marking mean nothing, which costs exactly the
   * documents that need it.
   */
  agentAuthored?: boolean
  /** Printed instead of a mermaid fence's source — see `markdownToBlocks`. */
  diagramPlaceholder?: string
}

/**
 * The marking, as the first thing on page one.
 *
 * A single-cell table rather than two paragraphs, because the border is the
 * part that does the work: it separates a statement ABOUT the document from
 * the document, and it keeps separating them after the reader has edited the
 * text around it. Reusing `table` also keeps the block vocabulary closed — a
 * `notice` kind would be a second thing every future exporter has to render.
 *
 * Unconditional on the answer's content: the claim is about who wrote the
 * document, which is true of a document with nothing in it too.
 */
/**
 * The marking's WORDS, once, for every format that has to print them.
 *
 * Formats disagree about how to draw it — the Word export makes it a
 * single-cell table so the border can carry it, the PDF draws it on the cover
 * above the facts — but they must not disagree about what it SAYS. Two copies
 * of „KI-generiert — nicht geprüft" is two things to keep in step, and the
 * failure mode is a document marked for one audience in one format only.
 */
export const aiNoticeText = (t: Translator): { title: string; body: string } => ({
  title: t('aiNotice.title'),
  body: t('aiNotice.body'),
})

export const agentNotice = (t: Translator): DocBlock => {
  const { title, body } = aiNoticeText(t)
  return {
    kind: 'table',
    rows: [[[{ text: `${title}\n`, bold: true }, { text: body }]]],
  }
}

/**
 * A reference-list entry as one paragraph.
 *
 * `[3]` in bold so the eye can find the marker the prose used, then the
 * Fundstelle, then the address on its own line — an architect checking a
 * citation reads the locator first and the URL only if the locator is not
 * enough.
 */
export const referenceParagraph = (entry: ReferenceEntry): DocBlock => {
  const runs: DocRun[] = [{ text: `[${entry.number}] `, bold: true }, { text: entry.label }]
  if (entry.page) runs.push({ text: `, ${entry.page}` })
  if (entry.note) runs.push({ text: ` — ${entry.note}`, italic: true })
  if (entry.url) runs.push({ text: `\n${entry.url}` })
  return { kind: 'paragraph', runs }
}

const confidenceBlocks = (confidence: AnswerConfidence, t: Translator): DocBlock[] => {
  const level = t(`confidenceLevels.${confidence.level}`)
  const blocks: DocBlock[] = [labelled(t('confidence'), level)]
  if (confidence.cappedReason) {
    const key = confidence.cappedReason === 'ungrounded' ? 'ungrounded' : 'quoteUnverified'
    blocks.push({
      kind: 'paragraph',
      runs: [{ text: t(`confidenceCapped.${key}`) }],
      style: 'meta',
    })
  }
  // Quoted rather than paraphrased: it is the model's own sentence about its own
  // answer, and rewriting it would make the export the author of a claim it only
  // carries.
  if (confidence.reason?.trim()) {
    blocks.push({
      kind: 'paragraph',
      runs: [
        { text: `${t('confidenceReason')}: `, bold: true },
        { text: confidence.reason.trim() },
      ],
      style: 'meta',
    })
  }
  return blocks
}

/**
 * One header fact: the small `Label: value` line under the document's title.
 *
 * Kept as data rather than pre-rendered into a paragraph because the two
 * exporters put the header in different PLACES. Word wants it inline, as the
 * first lines of the body — that is what a reader edits. The PDF puts it on a
 * cover, in a ruled label/value column, where a `Projekt: …` paragraph would
 * look like body text that escaped upward.
 */
export interface DocumentFact {
  label: string
  value: string
  /** Transcribed, not read — see `CoverFact.mono`. Ignored by the Word path. */
  mono?: boolean
}

/**
 * An answer, split into the parts a document is assembled from.
 *
 * The split exists so a second output format can present the header its own way
 * without re-deriving the header FACTS — which is where the honesty rule at the
 * top of this file lives, and therefore the one part that must not be written
 * twice.
 */
export interface AnswerSections {
  /** The document's own name; already fallen back, so never empty. */
  title: string
  /** Project and date, in reading order. Empty when the answer stated neither. */
  facts: DocumentFact[]
  /**
   * The AI marking, when this document was machine-authored — empty otherwise.
   *
   * Its own field rather than the head of `body`, because WHERE it goes is the
   * one thing about it that is not negotiable and each format answers it
   * differently: the PDF puts it above the cover facts, the Word export makes
   * it the first block on page one. A renderer that received it inside `body`
   * could place the cover between the title and the warning, which is the one
   * position it must never be in.
   *
   * Text rather than a rendered block, so the two formats cannot disagree about
   * what it SAYS while still drawing it differently — `agentNotice` builds the
   * Word table from it, the PDF cover draws it above the facts.
   */
  notice: { title: string; body: string } | null
  /** Everything below the header: question, answer, findings, sources. */
  body: DocBlock[]
}

/**
 * Assemble one answer into title, header facts and body.
 *
 * The prose's own written sources section is lifted out before the answer is
 * rendered, and used as the reference list only when no structured citations
 * were stored — otherwise the document would state the answer's sources twice,
 * in two lists with no guarantee of agreeing.
 */
export function buildAnswerSections(
  input: AnswerDocumentInput,
  t: Translator,
  locale: Locale
): AnswerSections {
  const { body, references: written } = splitProse(input.answer ?? '')
  const stored = referencesFromStored(input.citations, t)
  const references = stored.length > 0 ? stored : written

  const title = input.conversationTitle?.trim() || t('documentTitle')

  // The marking is its own section, not a fact and not the first body block.
  // A fact is a neutral label/value the header lays out in a row; „KI-generiert
  // — nicht geprüft" is a warning, and the format decides how to present one.
  // Putting it in `body` would let a renderer place the cover between it and
  // the title, which is the one position it must never be in.
  const notice = input.agentAuthored ? aiNoticeText(t) : null

  const projectName = input.projectName?.trim()
  const facts: DocumentFact[] = [
    ...(projectName ? [{ label: t('project'), value: projectName }] : []),
    ...(input.createdAt
      ? [
          {
            label: t('createdAt'),
            value: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(input.createdAt),
          },
        ]
      : []),
  ]

  const question = input.question?.trim()
  const questionSection: (DocBlock | null)[] = question
    ? [
        { kind: 'heading', level: 2, text: t('question') },
        { kind: 'paragraph', runs: [{ text: question }], style: 'quote' },
      ]
    : []

  const prose = markdownToBlocks(body, { diagramPlaceholder: input.diagramPlaceholder })
  const answerSection: (DocBlock | null)[] =
    prose.length > 0 ? [{ kind: 'heading', level: 2, text: t('answer') }, ...prose] : []

  const confidence = input.confidence ? confidenceBlocks(input.confidence, t) : []

  const cards = cardsBlocks(input.cards, t)
  const cardSection: DocBlock[] =
    cards.length > 0 ? [{ kind: 'heading', level: 2, text: t('findings') }, ...cards] : []

  const sourceSection: DocBlock[] =
    references.length > 0
      ? [{ kind: 'heading', level: 2, text: t('sources') }, ...references.map(referenceParagraph)]
      : []

  return {
    title,
    facts,
    notice,
    body: compact([
      ...questionSection,
      ...answerSection,
      ...confidence,
      ...cardSection,
      ...sourceSection,
    ]),
  }
}

/**
 * Build the document for one answer, as one flat block list.
 *
 * The header is folded back in at the top — a heading and one `Label: value`
 * paragraph per fact — which is the shape Word wants and the shape every
 * existing caller of this function already renders.
 */
export function buildAnswerDocument(
  input: AnswerDocumentInput,
  t: Translator,
  locale: Locale
): DocBlock[] {
  const { title, facts, notice, body } = buildAnswerSections(input, t, locale)
  return compact([
    // Before the title: the marking is what the document IS, and a reader who
    // reads one line of page one has to meet it.
    ...(notice ? [agentNotice(t)] : []),
    { kind: 'heading', level: 1, text: title },
    ...facts.map((fact) => labelled(fact.label, fact.value)),
    ...body,
  ])
}
