'use client'

import { Toggle } from '@/components/ui/toggle'

/**
 * One filter pill for the file surfaces — the Files folder quick-filter and the
 * Archiv category filter share this exact control (same height, radius, rest and
 * active treatment) instead of the two divergent chips they used before.
 */
export function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Toggle
      pressed={active}
      onPressedChange={() => onClick()}
      variant="inverted"
      size="default"
    >
      {label}
    </Toggle>
  )
}
