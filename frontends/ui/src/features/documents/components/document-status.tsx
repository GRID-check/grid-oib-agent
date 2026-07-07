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

export function documentStatusLabel(status: string | null | undefined, t: Translator): string {
  const key = (status ?? '').toLowerCase()
  const labelKey = STATUS_LABEL_KEY[key]
  if (labelKey) return t(labelKey)
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
