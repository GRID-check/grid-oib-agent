/**
 * SourceCard Component
 *
 * Card displaying a single source URL with optional metadata (title, snippet, discovery time).
 * Used by source/citation views to show cited and referenced sources.
 *
 * SSE Events:
 * - artifact.update where data.type === 'citation_source': Discovered URL
 * - artifact.update where data.type === 'citation_use': Cited URL
 */

'use client'

import { type FC } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Source information from SSE events */
export interface SourceInfo {
  /** Unique identifier */
  id: string
  /** Source URL */
  url: string
  /** Page title if available */
  title?: string
  /** Content snippet if available */
  snippet?: string
  /** When source was found */
  discoveredAt?: Date | string
  /** Whether source is used in final report */
  isCited: boolean
}

interface SourceCardProps {
  /** Source information */
  source: SourceInfo
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
    return url
  }
}

/**
 * Card showing a source URL with metadata.
 */
export const SourceCard: FC<SourceCardProps> = ({ source }) => {
  return (
    <a href={source.url} target="_blank" rel="noopener noreferrer" className="block">
      <div
        className={cn(
          'flex flex-col gap-1 rounded-lg border p-3 transition-colors hover:bg-accent',
          source.isCited && 'border-l-2 border-l-success'
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2">
          {/* Cited indicator */}
          {source.isCited && (
            <Check className="h-4 w-4 shrink-0 text-success" aria-label="Cited" role="img" />
          )}

          {/* Title or domain */}
          <span className="flex-1 truncate text-sm font-semibold">
            {source.title || getDomain(source.url)}
          </span>

          {/* Timestamp */}
          {source.discoveredAt && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(source.discoveredAt)}
            </span>
          )}
        </div>

        {/* URL */}
        <span className="truncate text-xs text-muted-foreground">{source.url}</span>

        {/* Snippet */}
        {source.snippet && (
          <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">{source.snippet}</span>
        )}
      </div>
    </a>
  )
}
