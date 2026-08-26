/**
 * Document status semantics — the single source of truth for how a document's
 * ingestion status maps to a Badge variant and a human label across the Files
 * workspace. Previously the same literal (e.g. 'uploaded') was coloured green in
 * one component and yellow in another; unifying here keeps status colour honest.
 *
 * Token map (per design language):
 *   ready / uploaded / ingested / success   → success
 *   ingesting / pending / processing / uploading → info
 *   failed / error                          → destructive
 *   anything else                           → secondary (neutral)
 */

'use client'

import { File, FileText, Image as ImageIcon, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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

type StatusVariant = 'success' | 'info' | 'destructive' | 'secondary'

const STATUS_VARIANT: Record<string, StatusVariant> = {
  ready: 'success',
  uploaded: 'success',
  ingested: 'success',
  success: 'success',
  completed: 'success',
  ingesting: 'info',
  pending: 'info',
  processing: 'info',
  uploading: 'info',
  failed: 'destructive',
  error: 'destructive',
}

const STATUS_LABEL_KEY: Record<string, string> = {
  ready: 'status.ready',
  uploaded: 'status.ready',
  ingested: 'status.ready',
  success: 'status.ready',
  completed: 'status.ready',
  ingesting: 'status.processing',
  pending: 'status.processing',
  processing: 'status.processing',
  uploading: 'status.uploading',
  failed: 'status.failed',
  error: 'status.failed',
}

export function documentStatusVariant(status: string | null | undefined): StatusVariant {
  return STATUS_VARIANT[(status ?? '').toLowerCase()] ?? 'secondary'
}

/**
 * Statuses that are going to change on their own — the `info` family above.
 * Anything else (citable, failed) is terminal and needs no watching.
 *
 * Callers use this to decide what to re-ask for: the workspace polls the
 * document list while one is unsettled, and a card treats a "no thumbnail yet"
 * answer for one as provisional rather than as the final word.
 */
const SETTLING_STATUSES = new Set(['uploading', 'ingesting', 'pending', 'processing'])

/** Ingestion wrote `completed`; the badge already treats that as citable. */
const CITABLE_STATUSES = new Set(['ready', 'uploaded', 'ingested', 'success', 'completed'])

const FAILED_STATUSES = new Set(['failed', 'error'])

export function isSettlingStatus(status: string | null | undefined): boolean {
  return SETTLING_STATUSES.has((status ?? '').toLowerCase())
}

/** The document is indexed and Ask may open it — not only the literal `ready`. */
export function isCitableStatus(status: string | null | undefined): boolean {
  return CITABLE_STATUSES.has((status ?? '').toLowerCase())
}

export function isFailedStatus(status: string | null | undefined): boolean {
  return FAILED_STATUSES.has((status ?? '').toLowerCase())
}

export function documentStatusLabel(status: string | null | undefined, t: Translator): string {
  const key = (status ?? '').toLowerCase()
  const labelKey = STATUS_LABEL_KEY[key]
  if (labelKey) return t(labelKey)
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : t('status.unknown')
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
}

export function DocumentStatusBadge({ status, className, title }: DocumentStatusBadgeProps) {
  const t = useTranslations('files')
  const label = documentStatusLabel(status, t)
  return (
    <Badge
      variant={documentStatusVariant(status)}
      className={cn('shrink-0', className)}
      // Defaults to the label itself, so a caller that has to constrain the
      // badge's width (the Files list column, where German "Wird hochgeladen" is
      // half again the width of English "Uploading") gets the full wording back
      // on hover and to assistive tech without threading the translator out to
      // the call site. An explicit `title` still wins — the chat peek passes the
      // status's CONSEQUENCE, which is more than the word.
      title={title ?? label}
    >
      {label}
    </Badge>
  )
}
