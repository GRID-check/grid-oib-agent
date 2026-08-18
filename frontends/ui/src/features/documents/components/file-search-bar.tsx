'use client'

import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Spinner } from '@/components/ui/spinner'

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
 * library share the sticky field, run button, and semantic-mode banner. The
 * field itself is the shared {@link SearchField} molecule.
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
          className="flex min-h-9 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <SearchField
            type="text"
            className="min-w-0 flex-1"
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
      </div>

      {semanticActive && (
        <div
          className="flex min-h-9 items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
          role="status"
          data-testid={bannerTestId}
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {isSearching ? (
              <Spinner size="xs" className="text-primary" />
            ) : (
              <Sparkles className="size-3.5 text-primary" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{bannerText}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground motion-reduce:transition-none"
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
