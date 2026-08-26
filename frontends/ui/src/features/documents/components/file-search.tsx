'use client'

import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface FileSearchFieldProps {
  value: string
  onChange: (value: string) => void
  /** Commit the query (Enter / the Search button) — runs the semantic search. */
  onSubmit: () => void
  onClear: () => void
  placeholder: string
  searchLabel: string
  resetLabel: string
  /** Whether the explicit-run semantic search is available (shows the run button). */
  canSearch: boolean
  runLabel: string
  isSearching: boolean
  className?: string
}

/**
 * The one search control every file surface uses — the Files browser and the
 * Archiv library share the field, the run button and the semantic banner below.
 *
 * It lives in the page's HEADER band now, beside the view toggles and the
 * upload button, rather than as a sticky strip over the listing: searching is
 * something you do TO the page, so it belongs with the page's other controls,
 * and the listing keeps the whole column it is given.
 *
 * Its width is responsive because its HOME is: from `lg` it sits in that header
 * row at a fixed measure, and below `lg` — where a field, two toggle groups and
 * an upload button cannot share a line with a page title — the surfaces render
 * it full width at the top of the listing instead. See
 * {@link FileWorkspaceActions} for which of the two is showing when.
 */
export function FileSearchField({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder,
  searchLabel,
  resetLabel,
  canSearch,
  runLabel,
  isSearching,
  className,
}: FileSearchFieldProps) {
  return (
    <form
      className={cn('flex min-h-9 min-w-0 items-center gap-2', className)}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <SearchField
        type="text"
        className="w-full min-w-0 sm:w-56 lg:w-60"
        value={value}
        onChange={onChange}
        onClear={onClear}
        placeholder={placeholder}
        label={searchLabel}
        clearLabel={resetLabel}
        inputClassName="pr-10 md:pr-9"
        clearClassName="right-1 size-9 pointer-coarse:size-11 md:right-1.5 md:size-6"
      />
      {canSearch && (
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="shrink-0 gap-1.5"
          disabled={value.trim() === '' || isSearching}
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {isSearching ? (
              <Spinner size="xs" label={runLabel} className="text-current" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
          </span>
          {runLabel}
        </Button>
      )}
    </form>
  )
}

interface SemanticSearchBannerProps {
  /**
   * How the band is framed. `inset` is a boxed strip inside a padded content
   * column (the Files browser); `band` is the full-bleed rule between two other
   * full-bleed bands (the Archiv sheet). Same content, same order, two frames —
   * a surface picks the one its neighbours already use.
   */
  variant?: 'inset' | 'band'
  isSearching: boolean
  /** Pre-formatted banner line ("Searching…" / "N results for …"). */
  bannerText: string
  resetLabel: string
  onReset: () => void
  testId: string
}

/**
 * The semantic-mode band. It stays with the LISTING, not with the field: it
 * describes the result set underneath it — how many, for which query, and the
 * way back to the full list — and none of that is an input.
 */
export function SemanticSearchBanner({
  variant = 'inset',
  isSearching,
  bannerText,
  resetLabel,
  onReset,
  testId,
}: SemanticSearchBannerProps) {
  return (
    <div
      className={cn(
        'border-primary/20 bg-primary/5 animate-in fade-in-0 duration-base flex min-h-9 shrink-0 items-center gap-2 text-xs ease-out motion-reduce:animate-none',
        variant === 'inset' ? 'mb-4 rounded-lg border px-3 py-2' : 'border-b px-4 py-2'
      )}
      role="status"
      data-testid={testId}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {isSearching ? (
          <Spinner size="xs" className="text-primary" />
        ) : (
          <Sparkles className="text-primary size-3.5" aria-hidden />
        )}
      </span>
      <span className="text-foreground min-w-0 flex-1 truncate">{bannerText}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground duration-snap hover:text-foreground h-7 shrink-0 gap-1.5 px-2 transition-colors ease-out motion-reduce:transition-none"
        onClick={onReset}
      >
        <X className="size-3.5" aria-hidden />
        {resetLabel}
      </Button>
    </div>
  )
}
