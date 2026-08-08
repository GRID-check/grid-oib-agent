'use client'

/**
 * The inbox count pill — the "needs you" badge of spec IB-18/IB-19.
 *
 * Deliberately a pure, presentational component: it takes a number and renders
 * it. The data lives in `useInboxBadge`, which the shell calls once, so this can
 * be rendered in a screenshot preview or a unit test without a fetch.
 *
 * The *shape* is not its business — that is `CountPill`, which already owns the
 * rounded-full numeric pill for every surface that needs one. This component is
 * only the three rules that make it an inbox badge:
 *   1. **Nothing at zero.** An empty circle beside a nav item reads as a bug, so
 *      `pending === 0` renders `null` — no wrapper, no whitespace.
 *   2. **The truth is in the label.** The visible number caps at `99+` so the
 *      pill cannot grow the nav row, but the `aria-label` always carries the real
 *      count (and picks the singular key, because this i18n layer has
 *      interpolation and no plural rules).
 *   3. **A count that is a call to act**, hence the pill's `attention` tone —
 *      near-black action ink, because the design language reserves chroma for
 *      provenance signals and ink stays legible on the collapsed rail's sunken
 *      surface.
 */

import { CountPill } from '@/components/ui/count-pill'
import { useTranslations } from '@/i18n'

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
    <CountPill
      tone="attention"
      // role="status" so a count that changes while the badge is mounted is
      // announced politely rather than silently repainted (NF-3).
      role="status"
      aria-label={label}
      data-testid="inbox-badge"
      data-pending={count}
      className={className}
    >
      <span aria-hidden>{count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : count}</span>
    </CountPill>
  )
}
