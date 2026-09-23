/**
 * A thin track of stages: the ones behind the subject filled, the ones ahead
 * empty, the one it is in half-filled, and a dashed outline where it stopped.
 *
 * ## Why a track and not a row of labels
 *
 * „In Prüfung" is only informative to somebody who already knows that Prüfung
 * comes after Entwurf and before Freigegeben. A fixed order of words is a model
 * the reader had to be taught somewhere else. The track IS the teaching: the
 * word beside it reads as a POSITION rather than as a label, and it costs four
 * pixels of height instead of a row of names.
 *
 * Lifted out of the document lifecycle's stand, where it was designed, when the
 * run block needed the same shape for its phases — two surfaces showing the same
 * thing compose the same atom, or they drift on the first token retune.
 *
 * ## The one place chroma is let in
 *
 * The design language spends colour on provenance
 * (`docs/design/grid-design-language.md`), and a bar that is ink from end to end
 * says „five segments" rather than „you are through three of them". So the
 * walked part takes a register — and only where the state EARNS one: a subject
 * still in flight is ink, because nothing has been asserted yet.
 *
 * Never the Büroarchiv gold: `--text-color-feedback-warning` is an alias of
 * `--source-office` (`styles/tokens.css` says so on the line), so a stop shares
 * the error tint rather than taking amber.
 *
 * Colour never travels alone: the track is `aria-hidden`, the state is named in
 * the line beneath it, and the stop is a dashed outline as well as a tint — so
 * it survives a monochrome print and a reader who cannot tell two tints apart.
 */

import { cn } from '@/lib/utils'

/**
 * What the walked segments are coloured by.
 *
 * Not one value per state: four, because the reader is being told one thing —
 * has anything happened yet, and was it good, a stop, or over.
 */
export type StageTrackTone = 'moving' | 'settled' | 'stopped' | 'retired'

const TONE_FILL: Record<StageTrackTone, string> = {
  moving: 'bg-foreground',
  settled: 'bg-[var(--text-color-feedback-success)]',
  stopped: 'bg-[var(--signal-error)]',
  retired: 'bg-muted-foreground/50',
}

/** The stop's outline, matched to the fill so the halt reads as one mark. */
const TONE_OUTLINE: Record<StageTrackTone, string> = {
  moving: 'border-muted-foreground/70',
  settled: 'border-muted-foreground/70',
  stopped: 'border-[var(--signal-error)]',
  retired: 'border-muted-foreground/50',
}

export interface StageTrackProps {
  /** The stages, in order. Their names ride as `data-stage` and nothing else. */
  stages: readonly string[]
  /** How many segments are behind the subject. */
  reached: number
  /**
   * The subject is INSIDE the next segment rather than before it — drawn at
   * half weight, so „walking into it" is visible without a second colour. A
   * track whose subject is between stages leaves this off.
   */
  active?: boolean
  /** The walk stopped here: the next segment is an outline, not a fill. */
  halted?: boolean
  tone?: StageTrackTone
  className?: string
  'data-testid'?: string
}

export function StageTrack({
  stages,
  reached,
  active = false,
  halted = false,
  tone = 'moving',
  className,
  'data-testid': testId,
}: StageTrackProps): JSX.Element {
  return (
    <div
      aria-hidden
      className={cn('flex items-center gap-1', className)}
      data-testid={testId}
      data-reached={reached}
      data-active={active || undefined}
      data-halted={halted || undefined}
      data-tone={tone}
    >
      {stages.map((stage, index) => {
        const done = index < reached
        const next = index === reached
        return (
          <span
            key={stage}
            data-stage={stage}
            data-done={done || undefined}
            className={cn(
              // A stage filling in is a change of colour and weight, so it
              // tweens — never springs (no chroma from motion).
              'h-1 flex-1 rounded-full transition-[background-color,opacity,border-color] duration-base ease-out motion-reduce:transition-none',
              done && TONE_FILL[tone],
              !done && 'bg-border',
              // The segment the subject is IN: the same fill at half weight. A
              // full one would claim a stage that has not finished, an empty one
              // would hide that anything is happening at all.
              !done && next && active && cn(TONE_FILL[tone], 'opacity-40'),
              // The stop: an outline rather than a fill, so „angehalten" does
              // not depend on the tint.
              !done && next && halted && cn('border border-dashed bg-transparent', TONE_OUTLINE[tone]),
            )}
          />
        )
      })}
    </div>
  )
}
