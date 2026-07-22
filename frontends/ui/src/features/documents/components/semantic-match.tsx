'use client'

import { Quote } from 'lucide-react'
import { useTranslations } from '@/i18n'

/**
 * Match-evidence block for a semantic-search result card — the transparent
 * "why it matched" cue the product requires: the best backend snippet, the page
 * it came from, and a subtle relevance bar + percent (score, 0..1). Rendered
 * inside both the project and Archiv file cards, so its labels live in the
 * shared `files` namespace. Visually distinct (primary tint) from the plain
 * filename filter so the user always knows they are seeing semantic results.
 */
export function SemanticMatch({ snippet, page, score }: { snippet: string; page: number | null; score: number }) {
  const t = useTranslations('files')
  const percent = Math.max(0, Math.min(100, Math.round(score * 100)))

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2"
      data-testid="semantic-match"
    >
      {snippet !== '' && (
        <p className="line-clamp-3 text-[11.5px] leading-[1.45] text-foreground/80" title={snippet}>
          <Quote className="mr-1 inline size-3 -translate-y-px text-primary/60" aria-hidden />
          {snippet}
        </p>
      )}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {page !== null && (
          <span className="shrink-0 font-medium tabular-nums" data-testid="semantic-page">
            {t('browser.semantic.page', { page: String(page) })}
          </span>
        )}
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5"
          title={t('browser.semantic.relevance', { percent: String(percent) })}
        >
          <span className="sr-only">{t('browser.semantic.relevance', { percent: String(percent) })}</span>
          <div className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 tabular-nums" aria-hidden>
            {percent}%
          </span>
        </div>
      </div>
    </div>
  )
}
