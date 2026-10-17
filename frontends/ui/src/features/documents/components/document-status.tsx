/**
 * Document status as the Files workspace renders it — the badge, its label, and
 * the three questions every surface asks about a status ("can Piloti quote it",
 * "did it fail", "will it change on its own").
 *
 * The vocabulary itself is NOT here. It lives in `@/lib/documents/document-status`
 * as data, because the server writes those values and the badge only reads them;
 * this module used to restate the whole set twice (a variant map and a label
 * map) and the server's poller restated it a third time. Everything below
 * DERIVES from that one declaration, so a new status is one entry there rather
 * than four edits nobody can find.
 */

'use client'

import { File, FileText, Image as ImageIcon, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { documentStatusFacts, type DocumentStatusVariant } from '@/lib/documents/document-status'
import {
  surfaceStateLabel,
  surfaceStateOf,
  surfaceStateVariant,
  type SurfaceState,
} from '@/lib/documents/surface-state'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import { IngestionGlyph } from './ingestion-atoms'

/** Pick a lucide icon that reflects the file's type. */
export function fileTypeIcon(contentType: string | null | undefined, filename?: string): LucideIcon {
  const type = (contentType ?? '').toLowerCase()
  const name = (filename ?? '').toLowerCase()
  if (type.startsWith('image/')) return ImageIcon
  if (
    type === 'application/pdf' ||
    type.startsWith('text/') ||
    type.includes('word') ||
    /\.(pdf|docx?|txt|md)$/.test(name)
  ) {
    return FileText
  }
  return File
}

/** Re-exported so the Files components keep one import for status questions. */
export type StatusVariant = DocumentStatusVariant

/**
 * The badge colour, read off the state the badge names (`surfaceStateVariant`),
 * so the colour and the word cannot disagree. An undeclared status is neutral
 * rather than green: the honest rendering of "nobody has said what this means".
 */
export function documentStatusVariant(status: string | null | undefined): StatusVariant {
  return surfaceStateVariant(surfaceStateOf(status))
}

/**
 * The document is going to change on its own — it is being uploaded, read or
 * indexed right now. Callers use this to decide what to re-ask for: the
 * workspace polls the document list while one is unsettled, and a card treats a
 * "no thumbnail yet" answer for one as provisional rather than as the final word.
 */
export function isSettlingStatus(status: string | null | undefined): boolean {
  return documentStatusFacts(status)?.phase === 'in-flight'
}

/**
 * The document is indexed and Ask may open it — not only the literal `ready`.
 *
 * Asked of the badge COLOUR on purpose: green is the product saying "Piloti can
 * quote this", so a status that renders green and a status that unlocks Ask are
 * the same claim. Two sets that must agree are one set.
 */
export function isCitableStatus(status: string | null | undefined): boolean {
  return documentStatusFacts(status)?.variant === 'success'
}

export function isFailedStatus(status: string | null | undefined): boolean {
  return documentStatusFacts(status)?.variant === 'destructive'
}

/**
 * A failed ingestion that left an earlier version citable.
 *
 * A new version that fails to process does not take the document out of search:
 * the ingestor keeps the previous version's passages, so Piloti goes on citing
 * it while the row (and the download) already point at the new bytes. One rule
 * for every surface that explains a failure — the pane under the error, the
 * chat peek in its strip — so the two cannot disagree about the same file.
 *
 * `versionCount` is `null`/absent on a payload that did not read it, which is
 * read as "no earlier version known": the single-version message is the
 * conservative one.
 */
export function failedWithPreviousVersion(file: {
  status?: string | null
  versionCount?: number | null
}): boolean {
  return isFailedStatus(file.status) && (file.versionCount ?? 0) > 1
}

/**
 * This document is not in the knowledge base, and nothing is reading it there.
 *
 * Asked of the status alone, for a person's upload and Piloti's own document
 * alike. Authorship used to override it ("nothing this product wrote is
 * citable"), which was true until ADR-0054 let a person publish Piloti's
 * document into the index. Since then the override showed a published,
 * indexed report as „nicht in der Wissensbasis“. What keeps an unapproved
 * machine document out is the dispatch guard (`dispatchDocument`, which reads
 * the row and sends only the version a person published) and the database
 * chain behind it, so `status` can only turn green for one a person approved.
 */
export function isNeverIndexed(file: { status?: string | null }): boolean {
  return isNeverIndexedStatus(file.status)
}

/**
 * The content check holds this document back (ADR-0086, *zurückgehalten*):
 * nothing reads it until someone allows it through (*zulassen*) or deletes it.
 * Asked of the state the badge names, so a surface's line and the badge agree.
 */
export function isHeldStatus(status: string | null | undefined): boolean {
  return surfaceStateOf(status) === 'held'
}

/**
 * Ask may open this document — the same claim the green badge makes, decided
 * by the same status (see {@link isNeverIndexed} for why authorship no longer
 * overrides it).
 */
export function isCitable(file: { status?: string | null }): boolean {
  return isCitableStatus(file.status)
}

/**
 * The document has come to rest outside the index: `stored` (a report Piloti
 * wrote that nobody published, or an archived document whose chunks were
 * purged) and `uploaded` (a row nothing was dispatched for). It is the case
 * where "not citable yet" would be a lie, because there is no "yet", and the
 * Ask affordance has to say so instead of promising a wait that never ends.
 *
 * An UNDECLARED status is not this: it also renders neutral, but what it means
 * is unknown, and "we never indexed it" is a claim only a declared value earns.
 */
export function isNeverIndexedStatus(status: string | null | undefined): boolean {
  const facts = documentStatusFacts(status)
  return facts !== null && facts.variant === 'secondary' && facts.phase === 'terminal'
}

function labelOfState(state: SurfaceState, status: string | null | undefined, t: Translator): string {
  // An undeclared value is drift, not vocabulary: it renders as the generic
  // unknown label — never the verbatim wire word — and is logged so the gap
  // gets closed in `document-status.ts` instead of leaking into the UI.
  if (state === 'unknown' && status) console.warn(`[document-status] Undeclared status "${status}", rendering as unknown`)
  return surfaceStateLabel(state, t)
}

/** The badge's word for a status. */
export function documentStatusLabel(status: string | null | undefined, t: Translator): string {
  return labelOfState(surfaceStateOf(status), status, t)
}

interface DocumentStatusBadgeProps {
  status: string | null | undefined
  className?: string
  /**
   * Hover/AT text saying what the status MEANS where the badge alone does not
   * carry it — the chat peek, where "processing" has a consequence ("Piloti
   * cannot read it yet") that the word on its own does not state.
   */
  title?: string
  /**
   * How many of the office's uploads wait ahead of this one in the ingest
   * queue. Shown only while the document is in flight and something is ahead;
   * zero or null leaves the status word alone.
   */
  queueAhead?: number | null
}

export function DocumentStatusBadge({ status, className, title, queueAhead }: DocumentStatusBadgeProps) {
  const t = useTranslations('files')
  // One state for the word, the colour and the glyph, so they cannot disagree.
  const state = surfaceStateOf(status)
  const variant = surfaceStateVariant(state)
  const waiting = queueAhead != null && queueAhead > 0 && documentStatusFacts(status)?.phase === 'in-flight'
  const label = waiting ? t('status.queuedAhead', { count: queueAhead }) : labelOfState(state, status, t)
  return (
    <Badge
      // A failed read is a fact in a row, so it takes the tinted error, the
      // material of every other status; the solid red plate shouted over the
      // documents beside it. `data-variant` keeps naming the status family.
      variant={variant === 'destructive' ? 'danger' : variant}
      // Lets a caller that repaints the ground (the card's frosted overlay)
      // repaint the ink for the one variant whose ink is white.
      data-variant={variant}
      className={cn('shrink-0', className)}
      // Defaults to the label itself, so a caller that has to constrain the
      // badge's width (the Files list column, where German "Wird hochgeladen" is
      // half again the width of English "Uploading") gets the full wording back
      // on hover and to assistive tech without threading the translator out to
      // the call site. An explicit `title` still wins — the chat peek passes the
      // status's CONSEQUENCE, which is more than the word.
      title={title ?? label}
    >
      {/* Icon + word + colour: the glyph is what tells „Wartet" from „Wird
          gelesen" (one blue) and „Abgelegt" from „Unbekannt" (one grey). */}
      <IngestionGlyph mark={waiting ? 'queued' : state} />
      {/* The word gives way, the glyph never does. A caller that caps the
          badge (the Files list's status column) gets an ellipsis at the end
          of the word; the badge's own centring clipped „Wartet · 3 Dateien
          davor" at both edges. */}
      <span className="min-w-0 truncate">{label}</span>
    </Badge>
  )
}
