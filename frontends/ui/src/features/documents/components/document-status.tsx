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
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { cn } from '@/lib/utils'

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

export function documentStatusVariant(status: string | null | undefined): StatusVariant {
  // An undeclared status is neutral rather than green: the honest rendering of
  // "nobody has said what this means" is a grey badge with the raw word in it.
  return documentStatusFacts(status)?.variant ?? 'secondary'
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
 * The document has come to rest without ever being indexed — today, exactly
 * `stored`: an agent-authored report, deliberately never dispatched to
 * `/v1/ingest`. It is the case where "not citable yet" would be a lie, because
 * there is no "yet", and the Ask affordance has to say so instead of promising
 * a wait that never ends.
 *
 * An UNDECLARED status is not this: it also renders neutral, but what it means
 * is unknown, and "we never indexed it" is a claim only a declared value earns.
 */
export function isNeverIndexedStatus(status: string | null | undefined): boolean {
  const facts = documentStatusFacts(status)
  return facts !== null && facts.variant === 'secondary' && facts.phase === 'terminal'
}

export function documentStatusLabel(status: string | null | undefined, t: Translator): string {
  const labelKey = documentStatusFacts(status)?.labelKey
  if (labelKey) return t(labelKey)
  // An undeclared value still has to read as SOMETHING; showing it verbatim is
  // what makes the drift visible to the person looking at the card.
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : t('status.unknown')
}

interface DocumentStatusBadgeProps {
  status: string | null | undefined
  className?: string
}

export function DocumentStatusBadge({ status, className }: DocumentStatusBadgeProps) {
  const t = useTranslations('files')
  return (
    <Badge variant={documentStatusVariant(status)} className={cn('shrink-0', className)}>
      {documentStatusLabel(status, t)}
    </Badge>
  )
}
