/**
 * A document's Anmerkungen as an office Protokoll: the file a Jour fixe is run
 * from, or the one sent to the client or a consultant (CONTEXT.md „Anmerkung":
 * the running number is what a Jour fixe and a Protokoll name).
 *
 * ## The read gate
 *
 * The export is a READ of the Anmerkungen, so it goes through the read every
 * listing goes through, {@link listAnnotations}, after
 * `getAccessibleDocument(…, 'read')`: a held upload, a document in a folder the
 * reader may not open (ADR-0087) and another organization's document are all
 * 404, exactly as they are for the Prüfansicht. Nothing here reads a mark
 * that route would not have shown this person.
 *
 * ## One structure, three files
 *
 * The Protokoll is built once as {@link DocBlock}s, the vocabulary the answer
 * export writes into, and handed to the renderers that already exist:
 * `renderDocx` (`lib/answer-export/docx.ts`) for Word, `BlocksDocument`
 * (`lib/pdf/blocks-to-pdf.tsx`) for PDF, and {@link blocksToMarkdown} below for
 * Markdown, the one format no renderer wrote yet. No dependency was added.
 *
 * No thumbnail of the marked place: the BFF has no page rasterizer (pages are
 * rendered by pdf.js in the browser, and crops by the agent's
 * `look`), so an entry names its page and nothing more.
 *
 * ## What is in it
 *
 * The office's marks, by number. Piloti's proposals that nobody took over are
 * not the office's (CONTEXT.md: they count only once a person takes them
 * over), so they are left out unless asked for, and then they stand under a
 * heading of their own, never among the marks. A mark Piloti set that a person
 * stands behind is in the list and says so („von Piloti gesetzt · für Anna"),
 * and so does each reply Piloti wrote („Piloti · für Anna").
 *
 * Nothing here calls a model, so nothing is traced to Langfuse; the export is
 * an audit event (`document.annotations.exported`), because office review
 * content leaving the product is worth a trail.
 */

import 'server-only'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName, splitDocumentName } from '@/lib/documents/display-name'
import { calendarDayIn, OFFICE_TIME_ZONE } from '@/lib/format'
import { listDocumentVersions } from '@/lib/documents/version-repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { escapeInline, escapeLineStarts, escapeMarkdown } from '@/lib/text/markdown-escape'
import { BlocksDocument } from '@/lib/pdf/blocks-to-pdf'
import type { CoverFact } from '@/lib/pdf/branding'
import { MAX_MARKDOWN_PDF_CHARS, PDF_MEDIA_TYPE, TABLE_CELL_COST_CHARS } from '@/lib/pdf/markdown-pdf'
import { DOCX_MEDIA_TYPE, renderDocx } from '@/lib/answer-export/docx'
import { labelled, paragraph, type DocBlock, type DocRun } from '@/lib/answer-export/blocks'
import { getLocale, getTranslations } from '@/i18n/server'
import type { Translator } from '@/i18n/translate'
import { listAnnotations } from './service'
import { isLive, isOverdue, type AnnotationView } from './types'
import { protocolFileNameOf, type AnnotationExportOptions } from './export-request'

export const MARKDOWN_MEDIA_TYPE = 'text/markdown; charset=utf-8'

export interface ExportedProtocol {
  /** The file's name with its extension, as a person reads it („Anmerkungen – Grundriss EG – Fassung 3.pdf"). */
  filename: string
  bytes: Uint8Array
  mediaType: string
}

/** The Fassung the document shows now, among all of its Fassungen. */
export interface ProtocolRevision {
  number: number
  total: number
  /** When this Fassung was filed (ISO). */
  createdAt: string
}

/** What the header states: about the document, and about this export. */
export interface ProtocolHeader {
  /** The name a person sees, with its extension. */
  documentName: string
  revision: ProtocolRevision | null
  projectName: string | null
  exportedAt: Date
  exportedBy: string
}

export interface ProtocolSelection {
  /** The office's marks, by number. */
  marks: AnnotationView[]
  /** Piloti's proposals nobody took over; empty unless asked for. */
  proposals: AnnotationView[]
}

/** A Protokoll before it is a file: the cover's title and facts, and the body. */
export interface Protocol {
  title: string
  facts: CoverFact[]
  body: DocBlock[]
}

/** Piloti's mark that no person took over: a proposal still, or one dismissed as one. */
const unreviewed = (annotation: AnnotationView): boolean =>
  annotation.authorKind === 'piloti' && annotation.acceptedBy === null

const byNumber = (a: AnnotationView, b: AnnotationView): number => a.number - b.number

/**
 * Which marks the export carries, and in which section. Pure.
 *
 * The Fassung narrows the RECORD, never the work: a mark still open from an
 * earlier Fassung is in every Protokoll, whatever `revision-links` says, and its
 * entry names the Fassung it was set on. A new Index arriving the day before
 * the Jour fixe does not answer the marks on the one before it, so a default
 * export that dropped them would drop exactly the points the meeting is for.
 * `revision-links=current` leaves out what was CLOSED on earlier Fassungen.
 */
export function selectMarks(
  annotations: readonly AnnotationView[],
  options: Pick<AnnotationExportOptions, 'scope' | 'revision' | 'includeProposals'>
): ProtocolSelection {
  const wanted = annotations.filter(
    (annotation) =>
      (options.revision === 'all' || annotation.onCurrentRevision || isLive(annotation)) &&
      (options.scope === 'all' || isLive(annotation))
  )
  return {
    marks: wanted.filter((annotation) => !unreviewed(annotation)).sort(byNumber),
    proposals: options.includeProposals ? wanted.filter(unreviewed).sort(byNumber) : [],
  }
}

export interface Formatters {
  /** A calendar day held as `YYYY-MM-DD`: a due date. */
  day: (isoDay: string) => string
  /** The day of an instant, on the office's calendar. */
  date: (iso: string) => string
  /** An instant, to the minute. */
  dateTime: (value: Date) => string
  /** Today on the office's calendar, `YYYY-MM-DD`. */
  today: string
}

export function formatters(locale: string, now: Date): Formatters {
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: OFFICE_TIME_ZONE })
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: OFFICE_TIME_ZONE,
  })
  return {
    day: (isoDay) => day.format(new Date(`${isoDay}T00:00:00Z`)),
    date: (iso) => date.format(new Date(iso)),
    dateTime: (value) => dateTime.format(value),
    today: calendarDayIn(OFFICE_TIME_ZONE, now),
  }
}

/** „Piloti · für Anna Berger", or plain „Piloti" when the directory does not know the person. */
const pilotiFor = (t: Translator, name: string | null): string =>
  name ? t('review.attribution.pilotiFor', { name }) : 'Piloti'

/** Who set the mark, who closed it, and whether Piloti works it now: one small line each. */
function attributionLines(annotation: AnnotationView, t: Translator, f: Formatters): string[] {
  const set = f.date(annotation.createdAt)
  const lines: string[] = []
  if (unreviewed(annotation)) {
    lines.push(
      annotation.createdByName
        ? t('review.export.document.proposalFor', { name: annotation.createdByName, date: set })
        : t('review.export.document.proposal', { date: set })
    )
  } else if (annotation.authorKind === 'piloti') {
    lines.push(
      annotation.acceptedByName
        ? t('review.export.document.pilotiSetFor', { name: annotation.acceptedByName, date: set })
        : t('review.export.document.pilotiSet', { date: set })
    )
  } else {
    lines.push(
      t('review.export.document.setBy', { name: annotation.createdByName ?? t('review.someone'), date: set })
    )
  }
  if (annotation.status === 'resolved' || annotation.status === 'dismissed') {
    const key = annotation.status === 'resolved' ? 'closedResolved' : 'closedDismissed'
    lines.push(
      t(`review.export.document.${key}`, {
        name: annotation.closedByName ?? t('review.someone'),
        date: annotation.closedAt ? f.date(annotation.closedAt) : '',
      })
    )
  }
  if (annotation.delegatedBy) lines.push(t('review.export.document.delegated', { name: annotation.delegatedByName ?? t('review.someone') }))
  return lines
}

/** Zuständig, Termin, Grundlage, and the Fassung it was set on when that is not the current one. */
function factLines(annotation: AnnotationView, t: Translator, f: Formatters): DocBlock[] {
  const blocks: DocBlock[] = []
  if (annotation.basis) blocks.push(labelled(t('review.export.document.basis'), annotation.basis))
  if (annotation.assigneeName) blocks.push(labelled(t('review.export.document.assignee'), annotation.assigneeName))
  if (annotation.dueOn) {
    const due = f.day(annotation.dueOn)
    const overdue = isOverdue(annotation, f.today) ? ` · ${t('review.overdue')}` : ''
    blocks.push(labelled(t('review.export.document.due'), `${due}${overdue}`))
  }
  if (!annotation.onCurrentRevision) {
    blocks.push(
      paragraph(
        annotation.revisionNumber === null
          ? t('annotations.earlierRevisionUnnumbered')
          : t('annotations.earlierRevision', { number: annotation.revisionNumber }),
        'meta'
      )
    )
  }
  return blocks
}

/** The thread: author · date, then what they wrote. Piloti's replies say for whom it wrote them. */
function threadBlocks(annotation: AnnotationView, t: Translator, f: Formatters): DocBlock[] {
  if (annotation.replies.length === 0) return []
  const items: DocRun[][] = annotation.replies.map((reply) => {
    const author =
      reply.authorKind === 'piloti' ? pilotiFor(t, reply.createdByName) : (reply.createdByName ?? t('review.someone'))
    return [{ text: `${author} · ${f.date(reply.createdAt)}: `, bold: true }, { text: reply.body }]
  })
  return [{ kind: 'paragraph', runs: [{ text: t('review.export.document.thread'), bold: true }] }, { kind: 'bullets', items }]
}

/** One mark: „Nr. 4 · Seite 2 · Mangel · offen", who stands behind it, the text, its facts and its thread. */
export function entryBlocks(annotation: AnnotationView, t: Translator, f: Formatters): DocBlock[] {
  const heading = t('review.export.document.entry', {
    number: annotation.number,
    page: annotation.page,
    kind: t(`annotations.kinds.${annotation.kind}`),
    status: t(`review.export.document.status.${annotation.status}`),
  })
  return [
    { kind: 'heading', level: 3, text: heading },
    ...attributionLines(annotation, t, f).map((line) => paragraph(line, 'meta')),
    paragraph(annotation.body),
    ...factLines(annotation, t, f),
    ...threadBlocks(annotation, t, f),
  ]
}

/** Whether the selection carries a mark set on an earlier Fassung. */
const carriesEarlier = (selection: ProtocolSelection): boolean =>
  [...selection.marks, ...selection.proposals].some((annotation) => !annotation.onCurrentRevision)

/**
 * Which Fassungen the Protokoll covers, as it IS: „aktuelle Fassung" only
 * while nothing from an earlier one is in it. Open marks come from every
 * Fassung, so an open-only Protokoll that carries an earlier one covers all
 * of them; one that keeps the record of the current Fassung says the open ones
 * of earlier Fassungen came along.
 */
function revisionPart(options: AnnotationExportOptions, selection: ProtocolSelection, t: Translator): string {
  if (options.revision === 'all') return t('review.export.document.revisions.all')
  if (!carriesEarlier(selection)) return t('review.export.document.revisions.current')
  return t(
    options.scope === 'open'
      ? 'review.export.document.revisions.all'
      : 'review.export.document.revisions.currentWithOpenFromEarlier'
  )
}

function scopeLine(options: AnnotationExportOptions, selection: ProtocolSelection, t: Translator): string {
  return [
    t(`review.export.document.scopes.${options.scope}`),
    revisionPart(options, selection, t),
    ...(options.includeProposals ? [t('review.export.document.withProposals')] : []),
  ].join(' · ')
}

function headerFacts(
  header: ProtocolHeader,
  selection: ProtocolSelection,
  options: AnnotationExportOptions,
  t: Translator,
  f: Formatters
): CoverFact[] {
  const revision = header.revision
  return [
    { label: t('review.export.document.document'), value: header.documentName },
    ...(revision
      ? [
          {
            label: t('review.export.document.revision'),
            value: t('review.export.document.revisionOf', {
              number: revision.number,
              total: revision.total,
              date: f.date(revision.createdAt),
            }),
          },
        ]
      : []),
    ...(header.projectName ? [{ label: t('review.export.document.project'), value: header.projectName }] : []),
    { label: t('review.export.document.scope'), value: scopeLine(options, selection, t) },
    { label: t('review.export.document.exportedAt'), value: f.dateTime(header.exportedAt) },
    { label: t('review.export.document.exportedBy'), value: header.exportedBy },
  ]
}

/** The Protokoll as a title, header facts and body blocks. Pure: the specs read it without rendering a file. */
export function buildProtocol(
  header: ProtocolHeader,
  selection: ProtocolSelection,
  options: AnnotationExportOptions,
  t: Translator,
  locale: string
): Protocol {
  const f = formatters(locale, header.exportedAt)
  const { stem } = splitDocumentName(header.documentName)
  const marks: DocBlock[] =
    selection.marks.length > 0
      ? selection.marks.flatMap((annotation) => entryBlocks(annotation, t, f))
      : [paragraph(t('review.export.document.none'))]
  const proposals: DocBlock[] =
    selection.proposals.length > 0
      ? [
          { kind: 'rule' },
          { kind: 'heading', level: 2, text: t('review.export.document.proposals') },
          paragraph(t('review.export.document.proposalsNote'), 'meta'),
          ...selection.proposals.flatMap((annotation) => entryBlocks(annotation, t, f)),
        ]
      : []
  return {
    title: t('review.export.document.title', { name: stem }),
    facts: headerFacts(header, selection, options, t, f),
    body: [{ kind: 'heading', level: 2, text: t('review.export.document.marks') }, ...marks, ...proposals],
  }
}

/** The title and the header facts as blocks, for the formats that have no cover page. */
const withHeader = (protocol: Protocol): DocBlock[] => [
  { kind: 'heading', level: 1, text: protocol.title },
  ...protocol.facts.map((fact) => labelled(fact.label, fact.value)),
  ...protocol.body,
]

function runsToMarkdown(runs: readonly DocRun[]): string {
  return runs
    .map((run) => {
      if (run.mono) return `\`${run.text.replace(/`/g, '')}\``
      const text = escapeInline(run.text)
      if (!text.trim()) return text
      // Emphasis may not open or close on a space, so the space stands outside it.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ['', '', text, '']
      const marked = run.bold && run.italic ? `***${core}***` : run.bold ? `**${core}**` : run.italic ? `*${core}*` : core
      return `${lead}${marked}${trail}`
    })
    .join('')
}

/** A line break inside a paragraph is a hard break (two spaces), never a new paragraph. */
const hardBreaks = (text: string, indent = ''): string => text.replace(/\n/g, `  \n${indent}`)

function blockToMarkdown(block: DocBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${escapeMarkdown(block.text).replace(/\n/g, ' ')}`
    case 'paragraph': {
      const text = hardBreaks(escapeLineStarts(runsToMarkdown(block.runs)))
      if (block.style === 'quote') return text.replace(/^/gm, '> ')
      // The small grey line is italic, unless it already carries a bold label (`labelled`).
      const plain = block.runs.every((run) => !run.bold && !run.italic && !run.mono)
      return block.style === 'meta' && plain && text.trim() ? `*${text.trim()}*` : text
    }
    case 'bullets':
      return block.items.map((item) => `- ${hardBreaks(escapeLineStarts(runsToMarkdown(item)), '  ')}`).join('\n')
    case 'table': {
      const cellText = (runs: DocRun[]) => runsToMarkdown(runs).replace(/\n/g, ' ')
      const width = block.head?.length ?? block.rows[0]?.length ?? 0
      const head = block.head ?? Array.from({ length: width }, () => ' ')
      return [
        `| ${head.map(escapeMarkdown).join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...block.rows.map((row) => `| ${row.map(cellText).join(' | ')} |`),
      ].join('\n')
    }
    case 'rule':
      return '---'
  }
}

/** Blocks as CommonMark: the shape a Protokoll pasted into an office's own minutes keeps. */
export function blocksToMarkdown(blocks: readonly DocBlock[]): string {
  return `${blocks.map(blockToMarkdown).join('\n\n')}\n`
}

/** What laying the blocks out costs react-pdf, in the unit `MAX_MARKDOWN_PDF_CHARS` bounds. */
function pdfRenderCost(blocks: readonly DocBlock[]): number {
  const runsLength = (runs: readonly DocRun[]) => runs.reduce((sum, run) => sum + run.text.length, 0)
  return blocks.reduce((sum, block) => {
    switch (block.kind) {
      case 'heading':
        return sum + block.text.length
      case 'paragraph':
        return sum + runsLength(block.runs)
      case 'bullets':
        // Each item is a flex row the layout pass measures, like a table cell.
        return sum + block.items.reduce((items, item) => items + runsLength(item) + TABLE_CELL_COST_CHARS, 0)
      case 'table':
        return sum + block.rows.flat().reduce((cells, cell) => cells + runsLength(cell) + TABLE_CELL_COST_CHARS, 0)
      case 'rule':
        return sum
    }
  }, 0)
}

/** What `renderToBuffer` accepts; react-pdf does not export `DocumentProps` (see `markdown-pdf.ts`). */
type PdfDocumentElement = Parameters<typeof renderToBuffer>[0]

async function renderPdf(protocol: Protocol): Promise<Uint8Array> {
  // The layout pass blocks the event loop and cannot be aborted, so a
  // Protokoll too long for it is refused before it starts (the bound and its
  // measurements: `MAX_MARKDOWN_PDF_CHARS`). Word and Markdown have no such pass.
  if (pdfRenderCost(protocol.body) > MAX_MARKDOWN_PDF_CHARS) {
    throw new UnprocessableError('This Protokoll is too long for a PDF; export it as Word or Markdown.', {
      reason: 'too-long-for-pdf',
    })
  }
  const element = React.createElement(BlocksDocument, {
    cover: { title: protocol.title, facts: protocol.facts },
    blocks: protocol.body,
  })
  return new Uint8Array(await renderToBuffer(element as unknown as PdfDocumentElement))
}

/** „Anmerkungen – Grundriss EG – Fassung 3.pdf": what the office files it under. */
export function protocolFileName(
  header: Pick<ProtocolHeader, 'documentName' | 'revision'>,
  options: Pick<AnnotationExportOptions, 'format' | 'revision'>,
  t: Translator
): string {
  const name = splitDocumentName(header.documentName).stem
  const stem =
    options.revision === 'all'
      ? t('review.export.document.fileNameAll', { name })
      : header.revision
        ? t('review.export.document.fileNameRevision', { name, number: header.revision.number })
        : t('review.export.document.fileName', { name })
  return protocolFileNameOf(stem, options.format)
}

export async function renderProtocol(protocol: Protocol, format: AnnotationExportOptions['format']) {
  if (format === 'pdf') return { bytes: await renderPdf(protocol), mediaType: PDF_MEDIA_TYPE }
  if (format === 'docx') return { bytes: renderDocx(withHeader(protocol)), mediaType: DOCX_MEDIA_TYPE }
  return { bytes: new TextEncoder().encode(blocksToMarkdown(withHeader(protocol))), mediaType: MARKDOWN_MEDIA_TYPE }
}

/** The Fassung the document shows now: its number among all of them, and when it was filed. */
async function currentRevision(session: AuthorizedSession, doc: Document): Promise<ProtocolRevision | null> {
  if (!doc.publishedVersionId) return null
  const versions = await listDocumentVersions(doc.id, session.organizationId)
  const current = versions.find((version) => version.id === doc.publishedVersionId)
  if (!current) return null
  return { number: current.versionNumber, total: versions.length, createdAt: current.createdAt.toISOString() }
}

async function readHeader(session: AuthorizedSession, doc: Document, now: Date): Promise<ProtocolHeader> {
  const [revision, project] = await Promise.all([
    currentRevision(session, doc),
    doc.projectId ? findProjectInOrg(doc.projectId, session.organizationId) : Promise.resolve(null),
  ])
  return {
    documentName: documentDisplayName(doc),
    revision,
    projectName: project?.name ?? null,
    exportedAt: now,
    exportedBy: session.name ?? session.email,
  }
}

/**
 * The document's Anmerkungen as a Protokoll file, for a person who may read
 * the document; 404 for anyone else, as the listing is.
 */
export async function exportAnnotationProtocol(
  session: AuthorizedSession,
  documentId: string,
  options: AnnotationExportOptions,
  request?: Request
): Promise<ExportedProtocol> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  const [{ annotations }, header, locale] = await Promise.all([
    listAnnotations(session, doc.id),
    readHeader(session, doc, new Date()),
    getLocale(),
  ])
  // Bound by name, so `key-coverage.spec.ts` checks every key this file asks for against `files`.
  const t = await getTranslations('files')
  const selection = selectMarks(annotations, options)
  const protocol = buildProtocol(header, selection, options, t, locale)
  const file = await renderProtocol(protocol, options.format)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.annotations.exported',
    targetType: 'document',
    targetId: doc.id,
    metadata: {
      format: options.format,
      scope: options.scope,
      revision: options.revision,
      includeProposals: options.includeProposals,
      markCount: selection.marks.length,
      proposalCount: selection.proposals.length,
    },
    request,
  })

  return { filename: protocolFileName(header, options, t), ...file }
}
