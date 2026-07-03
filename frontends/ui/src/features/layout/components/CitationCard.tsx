// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CitationCard Component
 *
 * Non-collapsible card displaying a single citation/source as a clickable link.
 * Shows a numbered index, the source domain, the captured excerpt (snippet) and
 * the full URL — so a citation reads as verifiable proof, not a bare hostname.
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
  /** 1-based position in the citation list, rendered as a numbered marker. */
  index?: number
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
 * Non-collapsible card showing a citation source: numbered, with title,
 * captured snippet and a verifiable link.
 */
export const CitationCard: FC<CitationCardProps> = ({ citation, index }) => {
  const excerpt = citation.content?.trim()

  return (
    <a
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="animate-in fade-in-0 block"
    >
      <div className="flex gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent">
        {/* Numbered marker */}
        {index != null && (
          <span
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-xs tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            {index}
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Header: cited/referenced state + domain + timestamp */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'shrink-0',
                citation.isCited ? 'text-success' : 'text-muted-foreground'
              )}
              aria-hidden="true"
            >
              {citation.isCited ? (
                <Check className="h-4 w-4" />
              ) : (
                <LinkIcon className="h-4 w-4" />
              )}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm font-semibold',
                citation.isCited ? 'text-success' : 'text-foreground'
              )}
            >
              {getDomain(citation.url)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(citation.timestamp)}
            </span>
          </div>

          {/* Captured excerpt (previously dropped) */}
          {excerpt && (
            <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{excerpt}</p>
          )}

          {/* Full URL — traceable source */}
          <span className="truncate break-all font-mono text-xs text-muted-foreground/80">
            {citation.url}
          </span>
        </div>
      </div>
    </a>
  )
}
