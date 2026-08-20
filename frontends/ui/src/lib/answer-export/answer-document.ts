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
  /** When the answer was written — never "now". */
  createdAt: Date
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
const agentNotice = (t: Translator): DocBlock => ({
  kind: 'table',
  rows: [[[{ text: `${t('aiNotice.title')}\n`, bold: true }, { text: t('aiNotice.body') }]]],
})

/**
 * A reference-list entry as one paragraph.
 *
 * `[3]` in bold so the eye can find the marker the prose used, then the
 * Fundstelle, then the address on its own line — an architect checking a
 * citation reads the locator first and the URL only if the locator is not
 * enough.
 */
const referenceParagraph = (entry: ReferenceEntry): DocBlock => {
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
 * Build the document for one answer.
 *
 * The prose's own written sources section is lifted out before the answer is
 * rendered, and used as the reference list only when no structured citations
 * were stored — otherwise the document would state the answer's sources twice,
 * in two lists with no guarantee of agreeing.
 */
export function buildAnswerDocument(
  input: AnswerDocumentInput,
  t: Translator,
  locale: Locale
): DocBlock[] {
  const { body, references: written } = splitProse(input.answer ?? '')
  const stored = referencesFromStored(input.citations, t)
  const references = stored.length > 0 ? stored : written

  const title = input.conversationTitle?.trim() || t('documentTitle')
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(input.createdAt)

  const notice: DocBlock[] = input.agentAuthored ? [agentNotice(t)] : []

  const header: (DocBlock | null)[] = [
    { kind: 'heading', level: 1, text: title },
    input.projectName?.trim() ? labelled(t('project'), input.projectName.trim()) : null,
    labelled(t('createdAt'), date),
  ]

  const question = input.question?.trim()
  const questionSection: (DocBlock | null)[] = question
    ? [
        { kind: 'heading', level: 2, text: t('question') },
        { kind: 'paragraph', runs: [{ text: question }], style: 'quote' },
      ]
    : []

  const prose = markdownToBlocks(body)
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

  return compact([
    ...notice,
    ...header,
    ...questionSection,
    ...answerSection,
    ...confidence,
    ...cardSection,
    ...sourceSection,
  ])
}
