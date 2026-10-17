import type { JSX } from 'react'
import type { ComponentProps } from 'react'
import { forwardRef } from 'react'
import { ButtonGroup } from '@/components/ui/button-group'
import { Button } from '@/components/ui/button'
import { FIELD_FOCUS_RING } from '@/components/ui/focus-ring'
import { cn } from '@/lib/utils'

/**
 * A toolbar that floats over the content it controls: the `ButtonGroup` pill
 * in glass, lifted one elevation step.
 *
 * On the popover plane, the token for anything floating over content.
 * Translucent because what is under it is the reader's document, and an
 * opaque bar over a page reads as a page cut off; blurred so the controls stay
 * legible over a drawing's linework. The same material as the chat toolbar's
 * pills across the seam, so the two halves of the row are one family.
 *
 * Under `prefers-contrast: more` the glass goes opaque and the hairline goes to
 * ink: translucency over a busy drawing is exactly what that reader asked not
 * to have to see through.
 */
export function FloatingToolbar({ className, ...props }: ComponentProps<typeof ButtonGroup>): JSX.Element {
  return (
    <ButtonGroup
      data-slot="floating-toolbar"
      className={cn(
        'border-base bg-popover/95 gap-0.5 shadow-md backdrop-blur-md',
        'contrast-more:bg-popover contrast-more:border-foreground/40',
        className,
      )}
      {...props}
    />
  )
}

/**
 * One icon control inside a toolbar pill: a `size-7` well with a `size-3.5`
 * glyph, which is the pairing the radius and glyph ladders give a `size-7`
 * well. Muted until it is pointed at, so a row of them reads as one quiet
 * object rather than as several buttons competing with the document.
 */
export function ToolbarIconButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'>): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        // Never squeezed: a pill too long for its stage scrolls, and every target keeps its 28px (WCAG 2.5.8).
        'text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-md [&_svg]:size-3.5 pointer-coarse:size-11',
        'aria-pressed:bg-accent aria-pressed:text-foreground contrast-more:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A control inside a pill whose face is a word or a number rather than a
 * glyph: the zoom level that fits again when pressed. The icon button's well
 * height and muted ink, at the width its words need.
 */
export function ToolbarTextButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'>): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'text-muted-foreground hover:text-foreground h-7 shrink-0 rounded-md px-1.5 text-xs font-normal tabular-nums pointer-coarse:h-11',
        'contrast-more:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A word or a number inside the pill: page position, a zoom level, a hit
 * count. Caption-sized, tabular so a counter that ticks does not make the pill
 * breathe, and never wrapped — a pill that grows a second line is no longer a
 * pill.
 */
export function ToolbarText({ className, ...props }: ComponentProps<'span'>): JSX.Element {
  return (
    <span
      data-slot="toolbar-text"
      className={cn(
        'text-muted-foreground contrast-more:text-foreground px-1.5 text-xs whitespace-nowrap tabular-nums',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A hairline between groups of controls in a pill.
 *
 * Decorative on purpose (`aria-hidden`, no `separator` role): the groups are
 * already named for assistive technology, and a `role="separator"` here is
 * indistinguishable from a split's resize handle to anything that looks one up
 * by role — which is how the chat peek's specs found the pill's divider instead
 * of the seam they were testing.
 */
export function ToolbarDivider({ className, ...props }: ComponentProps<'span'>): JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="toolbar-divider"
      className={cn('bg-border contrast-more:bg-foreground/40 mx-0.5 h-4 w-px shrink-0', className)}
      {...props}
    />
  )
}

/**
 * A typing surface inside a pill: the page number, a search query. The field
 * recipe (border promotion and halo on focus) at the pill's `size-7` height,
 * on the pill's own ground so it reads as cut into it rather than as a second
 * floating object. 16px on a coarse pointer, or iOS zooms the page on focus.
 */
export const ToolbarField = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function ToolbarField(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      data-slot="toolbar-field"
      className={cn(
        'border-input bg-input-background text-foreground placeholder:text-muted-foreground h-7 min-w-0 rounded-md border px-2 text-xs tabular-nums outline-none',
        'pointer-coarse:h-11 pointer-coarse:text-base',
        FIELD_FOCUS_RING,
        className,
      )}
      {...props}
    />
  )
})

/**
 * A short notice that floats over content in the toolbar's material: "the
 * passage could not be found", said where the reader is looking rather than in
 * a row above the document. An icon and a sentence, never an action — anything
 * the reader can DO goes in the toolbar.
 */
export function FloatingNote({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return (
    <p
      data-slot="floating-note"
      className={cn(
        'border-base bg-popover/95 text-muted-foreground flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-md backdrop-blur-md',
        'contrast-more:bg-popover contrast-more:border-foreground/40 contrast-more:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}
