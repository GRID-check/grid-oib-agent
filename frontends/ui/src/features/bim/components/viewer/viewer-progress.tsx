'use client'

/**
 * What the reader looks at while a hundred megabytes of building arrives.
 *
 * The old viewport spent this time showing a small grey chip in a corner
 * reading "12.847 Meshes" — a number that is meaningless to an architect,
 * placed where nobody was looking, on top of an empty canvas. Meanwhile the
 * download's real percentage was computed on every chunk and thrown away.
 *
 * So: the percentage is the bar, the bar is in the middle where the building
 * will be, and the wording says what is happening in the reader's terms. The
 * two phases are honest about their difference — a download has a known end
 * and gets a determinate bar; parsing does not and gets a moving one, because
 * a fake percentage that stalls at 90% is worse than no percentage.
 *
 * Rendered OVER the canvas rather than instead of it, so the first triangles
 * appear behind the bar and the reader sees the building assembling itself.
 * That is the difference between waiting and watching.
 */

import { cn } from '@/lib/utils'

export interface ViewerProgressProps {
  /** What is happening, in the reader's words. */
  label: string
  /** 0..100 for a determinate bar; null while there is nothing honest to show. */
  percent: number | null
  className?: string
}

export function ViewerProgress({ label, percent, className }: ViewerProgressProps): JSX.Element {
  const determinate = percent !== null && Number.isFinite(percent)
  const clamped = determinate ? Math.min(100, Math.max(0, percent)) : 0

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3',
        className
      )}
    >
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div
        role="progressbar"
        aria-label={label}
        // A determinate bar reports its position; an indeterminate one reports
        // none at all rather than a zero it would have to keep lying about.
        {...(determinate
          ? { 'aria-valuenow': Math.round(clamped), 'aria-valuemin': 0, 'aria-valuemax': 100 }
          : {})}
        className="h-1 w-48 overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn(
            'h-full rounded-full bg-foreground/70',
            determinate
              ? 'transition-[width] duration-300 ease-out motion-reduce:transition-none'
              : // A slow sweep, not a spinner: it says "still working" without
                // claiming a position it does not know.
                'w-1/3 animate-progress-sweep'
          )}
          {...(determinate ? { style: { width: `${clamped}%` } } : {})}
        />
      </div>
      {determinate && (
        <p className="text-xs tabular-nums text-muted-foreground">{Math.round(clamped)}%</p>
      )}
    </div>
  )
}
