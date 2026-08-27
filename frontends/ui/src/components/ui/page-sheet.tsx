'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { OVERLAY_MOTION, OVERLAY_EXIT, OVERLAY_REDUCED } from '@/components/ui/overlay-motion'

/**
 * Page sheet — a near-fullscreen surface that rises OVER the current page
 * instead of replacing it.
 *
 * The modal interrupts to ask a question and the side sheet shows the detail of
 * a row; this is the third intent: a whole PLACE (the Archiv, the Postfach)
 * that is independent of wherever the reader is standing. The page they came
 * from stays visible at the dimmed edges, which is the one visual claim a full
 * navigation cannot make: closing this returns you exactly there.
 *
 * Built on the same Radix Dialog as the other two — identical focus trap,
 * escape handling and scroll locking, no new dependency. On phones it takes
 * the true full screen; from `md` up it leaves a margin of app visible at the
 * top and sides and stays anchored to the bottom edge, iOS-page-sheet style,
 * with the panel capped and centred on very wide monitors.
 *
 * THE SLIDE. Same reasoning as the side sheet (see `sheet.tsx`): travel is the
 * panel's own height, so any spring's overshoot percentage is out of budget by
 * construction. A tween on `--ease-entrance` at `--motion-deliberate`, exit one
 * step shorter on `--ease-exit`.
 */

/**
 * The panel's geometry, shared with {@link PageSheetSkeleton} in
 * `components/shell` so the loading state cannot drift to a different box than
 * the sheet that replaces it.
 */
export const PAGE_SHEET_OVERLAY_CLASS = 'bg-overlay fixed inset-0 z-50 backdrop-blur-sm'
export const PAGE_SHEET_PANEL_CLASS =
  'bg-background fixed inset-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] md:inset-x-5 md:bottom-0 md:top-5 md:mx-auto md:rounded-t-2xl md:border md:border-b-0 md:pt-0 md:shadow-2xl'

/**
 * How wide the panel may grow from `md` up.
 *
 * `wide` is a whole PLACE (the Archiv's card grid); `reading` is a single
 * column of rows (the chat history) — at 1400px those rows would be lines of
 * whitespace with a title at one end and a timestamp at the other.
 */
const PANEL_WIDTHS = {
  wide: 'md:max-w-[1400px]',
  reading: 'md:max-w-2xl',
} as const

export type PageSheetWidth = keyof typeof PANEL_WIDTHS

interface PageSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The place's name — rendered as the header title and announced to AT. */
  title: string
  /** One line under the title; also the dialog's accessible description. */
  subtitle?: string
  /** Accessible label for the close button (i18n'd by the caller). */
  closeLabel: string
  /** Extra header controls, right-aligned beside the close button. */
  headerActions?: React.ReactNode
  /**
   * Skip the sheet's own header band. For content that already carries a full
   * identity row of its own (the Archiv workspace) a second title bar would
   * say the same name twice — instead the title goes sr-only and the content
   * hosts a {@link PageSheetClose} inside its existing row.
   */
  headerless?: boolean
  /** Panel width from `md` up — see {@link PANEL_WIDTHS}. */
  width?: PageSheetWidth
  /**
   * Where focus lands when the sheet opens, instead of Radix's default (the
   * first focusable). The history sheet hands it to its search field — finding
   * a past chat is why the sheet gets opened.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /** Applied to the body region between header and bottom edge. */
  bodyClassName?: string
  children: React.ReactNode
}

export function PageSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  closeLabel,
  headerActions,
  headerless = false,
  width = 'wide',
  initialFocusRef,
  bodyClassName,
  children,
}: PageSheetProps): JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            PAGE_SHEET_OVERLAY_CLASS,
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            OVERLAY_MOTION,
          )}
        />
        <DialogPrimitive.Content
          onOpenAutoFocus={
            initialFocusRef
              ? (event) => {
                  event.preventDefault()
                  initialFocusRef.current?.focus()
                }
              : undefined
          }
          className={cn(
            // From `md` up: bottom-anchored with app visible above and beside,
            // capped and centred on very wide screens. `border-b-0` because the
            // bottom edge is the screen edge — a hairline there reads as a gap.
            PAGE_SHEET_PANEL_CLASS,
            PANEL_WIDTHS[width],
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'ease-entrance data-[state=open]:duration-deliberate',
            OVERLAY_EXIT,
            OVERLAY_REDUCED,
          )}
        >
          {headerless ? (
            <>
              <DialogPrimitive.Title data-slot="page-sheet-title" className="sr-only">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {subtitle ?? title}
              </DialogPrimitive.Description>
            </>
          ) : (
            <header className="border-border flex shrink-0 items-start justify-between gap-4 border-b px-4 py-4 md:px-8 md:py-5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <DialogPrimitive.Title
                  data-slot="page-sheet-title"
                  className="text-foreground truncate text-lg font-semibold tracking-[-0.01em]"
                >
                  {title}
                </DialogPrimitive.Title>
                {subtitle ? (
                  <DialogPrimitive.Description className="text-muted-foreground truncate text-sm">
                    {subtitle}
                  </DialogPrimitive.Description>
                ) : (
                  // Radix warns when a described dialog has no description node;
                  // an explicitly absent one keeps the a11y tree quiet.
                  <DialogPrimitive.Description className="sr-only">
                    {title}
                  </DialogPrimitive.Description>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {headerActions}
                <PageSheetClose label={closeLabel} />
              </div>
            </header>
          )}
          <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/**
 * The sheet's close control, composable anywhere inside its content.
 *
 * Rides Radix's Dialog context, so a headerless sheet can hand this to the row
 * its content already owns (the Archiv workspace's identity row) instead of
 * floating a second control over it.
 */
export function PageSheetClose({ label }: { label: string }): JSX.Element {
  return (
    <DialogPrimitive.Close
      className={cn(
        'text-muted-foreground hover:bg-accent hover:text-foreground touch-target flex size-9 items-center justify-center rounded-lg outline-none transition-colors duration-quick ease-out motion-reduce:transition-none',
        FOCUS_RING,
      )}
    >
      <X className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  )
}
