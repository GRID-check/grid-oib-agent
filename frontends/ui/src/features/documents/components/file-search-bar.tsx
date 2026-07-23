'use client'

import { Search, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FileSearchBarProps {
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
  /** Whether semantic mode is showing its result banner. */
  semanticActive: boolean
  /** Pre-formatted banner line ("Searching…" / "N results for …"). */
  bannerText: string
  resetSemanticLabel: string
  onResetSemantic: () => void
  bannerTestId: string
}

/**
 * The one search bar every file surface uses — the Files browser and the Archiv
 * library shared ~80 lines of copy-pasted markup (sticky input, clear button,
 * run button, and the semantic-mode banner) that drifted independently. This
 * owns it once; callers pass their own i18n strings and semantic state.
 */
export function FileSearchBar({
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
  semanticActive,
  bannerText,
  resetSemanticLabel,
  onResetSemantic,
  bannerTestId,
}: FileSearchBarProps) {
  return (
    <>
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              aria-label={searchLabel}
              className="pl-8 pr-8"
            />
            {value !== '' && (
              <button
                type="button"
                onClick={onClear}
                aria-label={resetLabel}
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          {canSearch && (
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="shrink-0 gap-1.5"
              disabled={value.trim() === '' || isSearching}
            >
              {isSearching ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-3.5" aria-hidden />
              )}
              {runLabel}
            </Button>
          )}
        </form>
      </div>

      {/* Semantic-mode banner — transparent about which mode is active, with a
          clear reset back to the normal list. */}
      {semanticActive && (
        <div
          className="flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs"
          role="status"
          data-testid={bannerTestId}
        >
          {isSearching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-foreground">{bannerText}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            onClick={onResetSemantic}
          >
            <X className="size-3.5" aria-hidden />
            {resetSemanticLabel}
          </Button>
        </div>
      )}
    </>
  )
}
