'use client'

/**
 * The inbox count pill — the "needs you" badge of spec IB-18/IB-19.
 *
 * Deliberately a pure, presentational component: it takes a number and renders
 * it. The data lives in `useInboxBadge`, which the shell calls once, so this can
 * be rendered in a screenshot preview or a unit test without a fetch.
 *
 * Three rules it exists to hold:
 *   1. **Nothing at zero.** An empty circle beside a nav item reads as a bug, so
 *      `pending === 0` renders `null` — no wrapper, no whitespace.
 *   2. **The truth is in the label.** The visible number caps at `99+` so the
 *      pill cannot grow the nav row, but the `aria-label` always carries the real
 *      count (and picks the singular key, because this i18n layer has
 *      interpolation and no plural rules).
 *   3. **Ink, not colour.** The design language reserves chroma for provenance
 *      signals; the badge is the near-black action ink, which also keeps it
 *      legible on the collapsed rail's sunken surface.
 */

import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/** Above this the pill shows `99+` and stops growing. */
const DISPLAY_CAP = 99

export interface InboxBadgeProps {
  /** Items needing the user's attention. `0` (or less) renders nothing. */
  pending: number
  /**
   * Positioning/sizing overrides. The collapsed rail passes absolute placement
   * here so the pill can hug the icon tile.
   */
  className?: string
}

export function InboxBadge({ pending, className }: InboxBadgeProps): JSX.Element | null {
  const t = useTranslations('collaboration')

  if (!Number.isFinite(pending) || pending <= 0) return null

  const count = Math.floor(pending)
  const label = count === 1 ? t('inbox.badgeAriaOne') : t('inbox.badgeAria', { count })

  return (
    <span
      // role="status" so a count that changes while the badge is mounted is
      // announced politely rather than silently repainted (NF-3).
      role="status"
      aria-label={label}
      data-testid="inbox-badge"
      data-pending={count}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full',
        'bg-primary px-1.5 text-[10.5px] font-semibold tabular-nums text-primary-foreground',
        className,
      )}
    >
      <span aria-hidden>{count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : count}</span>
    </span>
  )
}
