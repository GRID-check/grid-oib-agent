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
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'

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
  const t = useTranslations('research')
  const { locale } = useLocale()
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <div
        className={cn(
          'flex flex-col gap-1 rounded-xl border bg-card p-3 shadow-xs transition-colors hover:bg-accent',
          // Cited: inset provenance rail, matching the chat's reasoning SourceCard.
          source.isCited && '[box-shadow:inset_3px_0_0_0_var(--source-project)]'
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2">
          {/* Cited indicator */}
          {source.isCited && (
            <Check className="h-4 w-4 shrink-0 text-success" aria-label={t('sourceCard.cited')} role="img" />
          )}

          {/* Title or domain */}
          <span className="flex-1 truncate text-sm font-semibold">
            {source.title || getDomain(source.url)}
          </span>

          {/* Timestamp */}
          {source.discoveredAt && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(source.discoveredAt, locale)}
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
