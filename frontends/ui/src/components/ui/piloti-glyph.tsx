import type { JSX } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

const SIZES = {
  xs: 'size-5 [&_svg]:size-2.5',
  sm: 'size-6 [&_svg]:size-3',
  md: 'size-7 [&_svg]:size-3.5',
  /** A list row's media tile (`ItemMedia`), with the spark at the row's icon size. */
  lg: 'size-8 [&_svg]:size-4',
} as const

const TONES = {
  ink: 'bg-foreground text-background',
  /**
   * The same face drawn as a line, for a list where every other row's icon is
   * an outlined tile (the inbox): the ink disc there read as the heaviest thing
   * on the page, louder than the requests it sat among.
   */
  outline: 'border border-border bg-card text-foreground',
} as const

/**
 * PilotiGlyph — Piloti's face wherever a person would show theirs: an ink disc
 * with its spark. Piloti never wears a person's avatar or an identity colour;
 * ink is its colour on the pages too (its marks, its pointer, the boxes it was
 * asked about).
 *
 * `working`: Piloti is busy right now; a soft ring breathes around the disc
 * (still under reduced motion). `tone="outline"`: the line version, beside
 * outlined icons.
 */
export function PilotiGlyph({
  size = 'sm',
  tone = 'ink',
  working,
  className,
  label,
}: {
  size?: keyof typeof SIZES
  tone?: keyof typeof TONES
  working?: boolean
  className?: string
  /** For a glyph that stands alone; beside the name „Piloti" it is decoration. */
  label?: string
}): JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="piloti-glyph"
      data-tone={tone}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full',
        TONES[tone],
        SIZES[size],
        className
      )}
    >
      <Sparkles aria-hidden />
      {working && (
        <span
          aria-hidden
          className="border-foreground/50 absolute -inset-[3px] animate-caret-breathe rounded-full border motion-reduce:animate-none"
        />
      )}
    </span>
  )
}
