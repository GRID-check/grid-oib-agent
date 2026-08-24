'use client'

/**
 * ConnectionPresenceIndicator
 *
 * A quiet, native-app-style status readout for the app shell: a small colored
 * dot (plus an optional label) that communicates live connection health so the
 * product never feels dead or ambiguous.
 *
 *   connected    -> subtle success dot, no motion (the resting, unremarkable state)
 *   reconnecting -> amber dot with a soft ping pulse (suppressed under
 *                   prefers-reduced-motion)
 *   offline      -> danger dot, no motion
 *
 * Accessibility: the wrapper is a `role="status"` / `aria-live="polite"` region
 * so assistive tech announces state changes calmly, not on every render. The
 * human-readable explanation is available both as the region's `aria-label` and
 * in a hover/focus tooltip. Colour is never the only signal -- the label and
 * tooltip carry the meaning in text.
 */

import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useConnectionPresence,
  type ConnectionPresence,
} from '@/shared/hooks/use-connection-presence'

/** Solid dot fill per state (feedback tokens from styles/tokens.css). */
const DOT_COLOR: Record<ConnectionPresence, string> = {
  connected: 'bg-success',
  reconnecting: 'bg-warning',
  offline: 'bg-danger',
}

export interface ConnectionPresenceIndicatorProps {
  /** Render only the dot (e.g. the collapsed sidebar rail). */
  compact?: boolean
  className?: string
  /**
   * Force a presence state instead of reading the live signal. Used by tests
   * and stories; production callers omit it so the hook drives the state.
   */
  presence?: ConnectionPresence
}

export function ConnectionPresenceIndicator({
  compact = false,
  className,
  presence: presenceOverride,
}: ConnectionPresenceIndicatorProps) {
  const t = useTranslations('presence')
  const detected = useConnectionPresence()
  const presence = presenceOverride ?? detected

  const label = t(`status.${presence}`)
  const tooltip = t(`tooltip.${presence}`)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="status"
          aria-live="polite"
          aria-label={label}
          data-presence={presence}
          className={cn(
            'inline-flex min-h-4 items-center gap-2 rounded-sm text-xs text-muted-foreground select-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          <span className="relative flex size-2 shrink-0" aria-hidden>
            {presence === 'reconnecting' && (
              // Soft radar pulse; removed entirely under reduced-motion.
              <span
                className={cn(
                  'absolute inline-flex size-full rounded-full opacity-60',
                  'animate-ping bg-warning motion-reduce:hidden motion-reduce:animate-none',
                )}
              />
            )}
            <span
              className={cn(
                'relative inline-flex size-2 rounded-full',
                DOT_COLOR[presence],
              )}
            />
          </span>
          {!compact && <span className="min-w-0 truncate">{label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="motion-reduce:animate-none">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
