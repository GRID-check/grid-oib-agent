'use client'

import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface FileSearchFieldProps {
  value: string
  onChange: (value: string) => void
  /** Commit the query. Enter always does this; the run button is optional. */
  onSubmit: () => void
  onClear: () => void
  placeholder: string
  searchLabel: string
  resetLabel: string
  /**
   * Draw a button that commits the query, and what to call it. Omit for a field
   * that reads as a plain filter — Enter still submits, so this decides how
   * VISIBLE the semantic run is, never whether it is reachable.
   */
  runButton?: { label: string; isSearching: boolean }
  /** Sizing for the form. Defaults to filling its row (the sticky band). */
  className?: string
}

interface FileSearchBannerProps {
  isSearching: boolean
  /** Pre-formatted banner line ("Searching…" / "N results for …"). */
  bannerText: string
  resetSemanticLabel: string
  onResetSemantic: () => void
  bannerTestId: string
}

type FileSearchBarProps = Omit<FileSearchFieldProps, 'runButton'> &
  FileSearchBannerProps & {
    /** Whether the explicit-run semantic search is available (shows the run button). */
    canSearch: boolean
    runLabel: string
    /** Whether semantic mode is showing its result banner. */
    semanticActive: boolean
  }

/**
 * The search control itself: the shared {@link SearchField} molecule plus the
 * button that commits the query to the semantic search.
 *
 * Separate from {@link FileSearchBar} because the field and its result banner
 * no longer always sit together — the Files browser puts the field in the page
 * header, beside the view toggles and Upload, and leaves the banner over the
 * listing the hits belong to.
 */
export function FileSearchField({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder,
  searchLabel,
  resetLabel,
  runButton,
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
      {runButton && (
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="shrink-0 gap-1.5"
          disabled={value.trim() === '' || runButton.isSearching}
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {runButton.isSearching ? (
              <Spinner size="xs" label={runButton.label} className="text-current" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
          </span>
          {runButton.label}
        </Button>
      )}
    </form>
  )
}

/**
 * What the committed search found, stated above the results it describes —
 * "Searching…", "N results for …", or the failure, with the way back to the
 * plain listing.
 */
export function FileSearchBanner({
  isSearching,
  bannerText,
  resetSemanticLabel,
  onResetSemantic,
  bannerTestId,
}: FileSearchBannerProps) {
  return (
    <div
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none"
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
        className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground transition-colors duration-snap ease-out hover:text-foreground motion-reduce:transition-none"
        onClick={onResetSemantic}
      >
        <X className="size-3.5" aria-hidden />
        {resetSemanticLabel}
      </Button>
    </div>
  )
}

/**
 * The sticky search band above a listing — field and banner in one strip. The
 * Archiv library uses it; the Files browser does not any more (its field is in
 * the page header, so a band would be a second search on the same screen).
 */
export function FileSearchBar({ semanticActive, canSearch, runLabel, ...props }: FileSearchBarProps) {
  return (
    <>
      {/* 95% + `backdrop-blur` is a frosted sticky band, not a hand-derived
          surface: the list has to stay faintly visible scrolling under it.
          `shrink-0` on both bands says the same thing the chip row now says:
          chrome above a listing never absorbs the listing's overflow. */}
      <div className="sticky top-0 z-10 shrink-0 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <FileSearchField
          {...props}
          runButton={canSearch ? { label: runLabel, isSearching: props.isSearching } : undefined}
        />
      </div>

      {semanticActive && <FileSearchBanner {...props} />}
    </>
  )
}
