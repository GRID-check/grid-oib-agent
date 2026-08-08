'use client'

import { cn } from '@/lib/utils'

/**
 * One filter pill for the file surfaces — the Files folder quick-filter and the
 * Archiv category filter share this exact control (same height, radius, rest and
 * active treatment) instead of the two divergent chips they used before.
 */
export function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none pointer-coarse:h-11 pointer-coarse:min-w-11',
        active
          ? 'bg-foreground text-background shadow-2xs'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}
