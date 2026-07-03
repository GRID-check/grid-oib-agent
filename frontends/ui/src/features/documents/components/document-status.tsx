// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

const STATUS_LABEL: Record<string, string> = {
  ready: 'Ready',
  uploaded: 'Ready',
  ingested: 'Ready',
  success: 'Ready',
  completed: 'Ready',
  ingesting: 'Processing',
  pending: 'Processing',
  processing: 'Processing',
  uploading: 'Uploading',
  failed: 'Failed',
  error: 'Failed',
}

export function documentStatusVariant(status: string | null | undefined): StatusVariant {
  return STATUS_VARIANT[(status ?? '').toLowerCase()] ?? 'secondary'
}

export function documentStatusLabel(status: string | null | undefined): string {
  const key = (status ?? '').toLowerCase()
  return STATUS_LABEL[key] ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown')
}

interface DocumentStatusBadgeProps {
  status: string | null | undefined
  className?: string
}

export function DocumentStatusBadge({ status, className }: DocumentStatusBadgeProps) {
  return (
    <Badge variant={documentStatusVariant(status)} className={cn('shrink-0', className)}>
      {documentStatusLabel(status)}
    </Badge>
  )
}
