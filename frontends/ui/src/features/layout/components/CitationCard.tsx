// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CitationCard Component
 *
 * Non-collapsible card displaying a single citation/source as a clickable link.
 * Shows title/domain and full URL.
 *
 * SSE Events:
 * - artifact.update type: "citation_source" - Referenced (discovered during search)
 * - artifact.update type: "citation_use" - Cited (actually used in report)
 */

'use client'

import { type FC } from 'react'
import { Check, Link as LinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CitationSource } from '@/features/chat/types'

interface CitationCardProps {
  /** Citation information */
  citation: CitationSource
}

/**
 * Format timestamp for display
 */
const formatTime = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Extract domain from URL for display
 */
const getDomain = (url: string): string => {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname.replace('www.', '')
  } catch {
    return url.substring(0, 30)
  }
}

/**
 * Non-collapsible card showing a citation source as a clickable link.
 */
export const CitationCard: FC<CitationCardProps> = ({ citation }) => {
  return (
    <a href={citation.url} target="_blank" rel="noopener noreferrer" className="block">
      <div className="flex flex-col overflow-hidden rounded-lg border bg-muted/40 transition-colors hover:bg-accent">
        {/* Header */}
        <div className="flex w-full items-center gap-2 px-3 py-2">
          {/* Status Icon - Cited vs Referenced */}
          <span
            className={cn('shrink-0', citation.isCited ? 'text-success' : 'text-muted-foreground')}
            aria-hidden="true"
          >
            {citation.isCited ? <Check className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
          </span>

          {/* Citation Title */}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-semibold',
              citation.isCited ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {getDomain(citation.url)}
          </span>

          {/* Timestamp */}
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatTime(citation.timestamp)}
          </span>
        </div>

        {/* Full URL */}
        <div className="flex border-t px-3 pb-2">
          <span className="mt-1 truncate break-all text-sm text-muted-foreground">
            {citation.url}
          </span>
        </div>
      </div>
    </a>
  )
}
