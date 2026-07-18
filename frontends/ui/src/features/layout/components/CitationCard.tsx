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
import { useLocale } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import type { CitationSource } from '@/features/chat/types'

interface CitationCardProps {
  /** Citation information */
  citation: CitationSource
  /** 1-based position in the citation list, rendered as a numbered marker. */
  index?: number
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
  const { locale } = useLocale()
  const excerpt = citation.content?.trim()
  const href = citation.url && /^https?:\/\//i.test(citation.url) ? citation.url : undefined
  const title =
    citation.title?.trim() ||
    citation.fileName?.trim() ||
    citation.citationKey?.trim() ||
    (href ? getDomain(href) : excerpt?.split('\n')[0]?.slice(0, 48)) ||
    'Source'

  const body = (
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
              {title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(citation.timestamp, locale)}
            </span>
          </div>

          {/* Captured excerpt (previously dropped) */}
          {excerpt && (
            <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{excerpt}</p>
          )}

          {/* Full URL or structured locator — traceable source */}
          <span className="truncate break-all font-mono text-xs text-muted-foreground/80">
            {href || citation.citationKey || citation.fileName || ''}
          </span>
        </div>
      </div>
  )

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="animate-in fade-in-0 block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {body}
      </a>
    )
  }

  return (
    <div className="animate-in fade-in-0 block rounded-lg">
      {body}
    </div>
  )
}
