/**
 * A live level meter drawn as a row of bars: the newest sample on the right.
 * The caller owns the samples (0 to 1, already scaled); this only draws them,
 * so a recording control, a playback row or a preview can share one look.
 */

import { cn } from '@/lib/utils'

export interface AudioWaveProps {
  /** Levels from 0 (silence) to 1 (loud), oldest first. */
  levels: readonly number[]
  className?: string
}

/** The shortest bar, so silence still reads as a meter rather than as nothing. */
const MIN_BAR = 0.12

export function AudioWave({ levels, className }: AudioWaveProps) {
  return (
    <span aria-hidden="true" className={cn('inline-flex h-4 items-center gap-[2px]', className)}>
      {levels.map((level, index) => (
        <span
          key={index}
          className="h-full w-[2px] rounded-full bg-current transition-transform duration-snap ease-out motion-reduce:transition-none"
          // Scaled, not resized: a transform is composited, a height re-runs layout every frame.
          style={{ transform: `scaleY(${Math.max(MIN_BAR, Math.min(1, level)).toFixed(2)})` }}
        />
      ))}
    </span>
  )
}
