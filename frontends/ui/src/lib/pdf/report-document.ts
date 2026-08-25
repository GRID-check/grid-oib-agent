/**
 * The request body of `POST /api/generate-pdf`, and the document it becomes.
 *
 * ## Why the payload grew instead of being replaced
 *
 * The endpoint shipped taking `{ markdown }`, and that is still the whole of
 * what `useDownloadPdfRoute` sends. A richer export needs the facts a report's
 * markdown cannot carry — which project it belongs to, which question it
 * answers, which cards the answer emitted, which sources it rests on — but a
 * second endpoint would leave two PDF renderers to keep in step, and a required
 * new field would break the caller that exists.
 *
 * So every field but the prose is optional, and absence is meaningful rather
 * than defaulted: no `cards` means a document with no findings section, not an
 * empty one; no `createdAt` means no date on the cover, not today's. That is
 * the same rule `answer-document.ts` is built around, and it matters here for
 * the same reason — the file is read away from the app by someone who cannot
 * check it against anything.
 *
 * ## Why the two paths differ
 *
 * A stored ANSWER is chrome around prose: it has a question above it, findings
 * below it and a confidence line, so `buildAnswerSections` wraps the prose in a
 * translated "Answer" heading to separate it from its neighbours.
 *
 * A research REPORT is the document. Wrapping it in an "Answer" heading would
 * announce a section that is the entire file. So the markdown-only path builds
 * its own sections: the report's own leading `# Title` becomes the cover title
 * (a title printed twice reads as a duplication bug), and its written sources
 * section is lifted into a real reference list instead of being left as prose.
 */

import { marked } from 'marked'
import { z } from 'zod'
import {
  aiNoticeText,
  buildAnswerSections,
  referenceParagraph,
  type AnswerSections,
} from '@/lib/answer-export/answer-document'
import type { DocBlock } from '@/lib/answer-export/blocks'
import { splitProse } from '@/lib/answer-export/citations'
import { markdownToBlocks } from '@/lib/answer-export/markdown'
import { resolveLocale, type Locale } from '@/i18n/config'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'

/**
 * The accepted body.
 *
 * `.passthrough()` and the nullish spellings mirror `citations.ts`: this is a
 * public-ish endpoint reached from a browser, and a client one deploy ahead or
 * behind must degrade to the fields we recognise rather than fail the whole
 * export. `cards` and `citations` stay `unknown` on purpose — they are handed
 * to the walkers in `cards.ts` and `citations.ts`, which are written to read
 * them as untrusted jsonb and are the only place that knows their shape.
 */
export const pdfRequestSchema = z
  .object({
    /** The report or answer prose, as markdown. The original contract. */
    markdown: z.string().nullish(),
    /** The document's own name; falls back to the prose's leading heading. */
    title: z.string().nullish(),
    projectName: z.string().nullish(),
    /** The question this answers, when the document is one answer. */
    question: z.string().nullish(),
    /** ISO-8601. Anything unparseable is treated as absent, never as now. */
    createdAt: z.string().nullish(),
    cards: z.unknown().optional(),
    citations: z.unknown().optional(),
    confidence: z
      .object({
        level: z.enum(['low', 'medium', 'high']),
        reason: z.string().nullish(),
        cappedReason: z.enum(['ungrounded', 'quote_unverified']).nullish(),
      })
      .nullish(),
    /** The language the reader read the answer in; defaults to the app default. */
    locale: z.string().nullish(),
    /**
     * Print the „KI-generiert — nicht geprüft" marking above the cover facts.
     *
     * Set by the FILING path, never by the browser export: a person exporting
     * prose they have read and chosen to download is the case
     * `MarkdownPdfOptions.aiProvenance` names as the reason the marking is
     * opt-in, and a stamp on every PDF is a stamp that means nothing. A document
     * Piloti wrote into a project is the other case — it leaves the product
     * without a byline to carry it.
     */
    aiProvenance: z.string().optional(),
    /** Printed instead of a mermaid fence's source — see `markdownToBlocks`. */
    diagramPlaceholder: z.string().optional(),
    /**
     * Facts the caller knows and the prose does not — Standort, Bundesland,
     * Gebäudeklasse. Appended after the ones derived here.
     *
     * Bundesland is the reason this field exists rather than the cover being
     * fixed at project + date: a compliance statement without it is not
     * checkable, because it is the line that says which Bauordnung the document
     * was checked against.
     */
    facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  })
  .passthrough()

export type PdfRequest = z.infer<typeof pdfRequestSchema>

/** A date that was actually stated, or null. Never "now". */
const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * Whether the payload carries anything a document can be built from.
 *
 * Cards alone are enough: an answer whose whole content is a compliance card
 * has no prose, and refusing to export it would be the endpoint deciding that
 * a finding is not a document.
 */
export const hasContent = (request: PdfRequest): boolean =>
  Boolean(trimmed(request.markdown)) || (Array.isArray(request.cards) && request.cards.length > 0)

/**
 * Whether anything beyond the prose was sent.
 *
 * Read as "did the caller opt into the richer contract", not as "is there
 * enough data": a caller that sends only a title still gets the answer-shaped
 * document, because it asked for one.
 */
const isRichRequest = (request: PdfRequest): boolean =>
  Boolean(
    trimmed(request.title) ||
      trimmed(request.projectName) ||
      trimmed(request.question) ||
      trimmed(request.createdAt) ||
      request.cards !== undefined ||
      request.citations !== undefined ||
      request.confidence
  )

/**
 * Lift a report's own leading `# Heading` off the front of its markdown.
 *
 * Lexed rather than pattern-matched on the raw text, so a `#` inside a fenced
 * code block at the top of a report is not mistaken for the report's title.
 */
const liftLeadingTitle = (markdown: string): { title: string | null; body: string } => {
  const tokens = marked.lexer(markdown)
  const first = tokens.find((token) => token.type !== 'space')
  if (!first || first.type !== 'heading' || first.depth !== 1) return { title: null, body: markdown }

  const heading = first as { text: string; raw: string }
  const title = heading.text.trim()
  if (!title) return { title: null, body: markdown }

  const start = markdown.indexOf(heading.raw)
  return start === -1
    ? { title, body: markdown }
    : { title, body: markdown.slice(start + heading.raw.length) }
}

/**
 * A research report, as sections.
 *
 * The reference list is built the same way the answer path builds it, from the
 * sources section the report wrote into its own prose — so the `[3]` markers
 * left in the body still point at something, which is the entire reason
 * `splitProse` exists.
 */
const reportSections = (
  markdown: string,
  request: PdfRequest,
  t: ReturnType<typeof createTranslator>
): AnswerSections => {
  const { body, references } = splitProse(markdown)
  const lifted = liftLeadingTitle(body)

  const projectName = trimmed(request.projectName)
  const created = parseDate(request.createdAt)

  return {
    title: trimmed(request.title) ?? lifted.title ?? t('documentTitle'),
    notice: request.aiProvenance ? aiNoticeText(t) : null,
    facts: [
      ...(projectName ? [{ label: t('project'), value: projectName }] : []),
      ...(created
        ? [
            {
              label: t('createdAt'),
              value: new Intl.DateTimeFormat(resolveLocale(request.locale), {
                dateStyle: 'long',
              }).format(created),
            },
          ]
        : []),
      ...(request.facts ?? []),
    ],
    body: [
      ...markdownToBlocks(lifted.body, { diagramPlaceholder: request.diagramPlaceholder }),
      ...(references.length > 0
        ? ([
            { kind: 'heading', level: 2, text: t('sources') },
            ...references.map(referenceParagraph),
          ] as DocBlock[])
        : []),
    ],
  }
}

/**
 * Turn one request into the sections a branded document is drawn from.
 *
 * Both paths end in the same `DocBlock[]`, which is what lets one renderer
 * (`blocks-to-pdf.tsx`) draw a stored answer with forty card types and a plain
 * research report without knowing which it was handed.
 */
export function documentSections(request: PdfRequest): { sections: AnswerSections; locale: Locale } {
  const locale = resolveLocale(request.locale)
  const t = createTranslator(getDictionary(locale), 'answerExport')
  const markdown = request.markdown ?? ''

  if (!isRichRequest(request)) {
    return { sections: reportSections(markdown, request, t), locale }
  }

  // A caller that sent no title still gets the prose's own `# Heading` as one —
  // and the heading is then taken OUT of the body, because a title printed on
  // the cover and again as the first line of page two reads as a bug.
  const given = trimmed(request.title)
  const lifted = given ? { title: null, body: markdown } : liftLeadingTitle(markdown)

  const sections = buildAnswerSections(
    {
      conversationTitle: given ?? lifted.title ?? null,
      projectName: trimmed(request.projectName) ?? null,
      question: trimmed(request.question) ?? null,
      answer: lifted.body,
      createdAt: parseDate(request.createdAt),
      citations: request.citations,
      cards: request.cards,
      agentAuthored: Boolean(request.aiProvenance),
      diagramPlaceholder: request.diagramPlaceholder,
      confidence: request.confidence
        ? {
            level: request.confidence.level,
            ...(trimmed(request.confidence.reason)
              ? { reason: trimmed(request.confidence.reason) }
              : {}),
            ...(request.confidence.cappedReason
              ? { cappedReason: request.confidence.cappedReason }
              : {}),
          }
        : null,
    },
    t,
    locale
  )

  // The caller's own facts land on BOTH paths. A filed report carries Standort,
  // Bundesland and Gebäudeklasse, and it reaches this branch rather than
  // `reportSections` as soon as it has cards — which every report with a
  // Rechtsgrundlage does. Dropping them here printed a cover with a title and
  // nothing under it, and lost the line that says which Bauordnung the document
  // was checked against.
  return {
    sections: { ...sections, facts: [...sections.facts, ...(request.facts ?? [])] },
    locale,
  }
}
