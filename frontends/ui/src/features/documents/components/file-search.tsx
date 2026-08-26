'use client'

import { SearchField } from '@/components/ui/search-field'
import { cn } from '@/lib/utils'

interface FileSearchFieldProps {
  value: string
  onChange: (value: string) => void
  /** Commit the query to the semantic search. Enter does this. */
  onSubmit: () => void
  onClear: () => void
  placeholder: string
  searchLabel: string
  resetLabel: string
  className?: string
}

/**
 * The one search control every file surface uses — the Files browser and the
 * Archiv library share it.
 *
 * It lives in the page's HEADER band now, beside the view toggles and the
 * upload button, rather than as a sticky strip over the listing: searching is
 * something you do TO the page, so it belongs with the page's other controls,
 * and the listing keeps the whole column it is given.
 *
 * No run button beside it, and no banner over the results. The field reads as
 * the plain filter it mostly is, the way History's does; Enter still commits
 * the query to the semantic search, which is the only thing the button added.
 * What the banner carried has better homes: the skeletons say a search is
 * running, the empty and failed panels say what came back, and the field's own
 * ✕ is the way out of a search.
 *
 * Its width is responsive because its HOME is: from `lg` it sits in that header
 * row at a fixed measure, and below `lg` — where a field, a toggle group and an
 * upload button cannot share a line with a page title — the surfaces render it
 * full width at the top of the listing instead. See {@link FileWorkspaceActions}
 * for which of the two is showing when.
 */
export function FileSearchField({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder,
  searchLabel,
  resetLabel,
  className,
}: FileSearchFieldProps) {
  return (
    <form
      className={cn('flex min-h-9 min-w-0 items-center', className)}
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
    </form>
  )
}
