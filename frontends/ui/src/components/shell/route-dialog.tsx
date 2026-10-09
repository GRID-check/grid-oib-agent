'use client'

import type { JSX } from 'react'
import * as React from 'react'
import { useRouter } from 'next/navigation'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * A {@link Dialog} that IS a route: the sibling of `RoutePageSheet` for content
 * that is one artifact to look at, not a place (the design language's overlay
 * table). The upload summary is the first: an inbox row links to
 * `/app/uploads/<id>`, and the summary rises over whatever page the reader was
 * on, with a URL they can reload or send.
 *
 * Same two arrivals as the sheet, and only `standalone` tells them apart:
 *
 *  - intercepted (`(shell)/@overlay/(.)…`): closing is `router.back()`, so the
 *    URL and the page underneath return to where they were (from the Postfach,
 *    back to the Postfach).
 *  - hard load: there is no history entry of this app's to return to, so
 *    closing pushes `fallbackHref`.
 *
 * The navigation waits for the exit animation, as the sheet's does, so the
 * dialog is seen leaving rather than cut off by the route unmounting. A timer
 * one step longer than the exit backs the `animationend` up: with reduced
 * motion there is no animation to end.
 */

/** `--motion-quick` (the dialog's exit) plus a frame or two. */
const EXIT_FALLBACK_MS = 220

export interface RouteDialogProps {
  title: string
  /** One line under the title; also the dialog's accessible description. */
  description?: React.ReactNode
  closeLabel: string
  standalone?: boolean
  fallbackHref?: string
  /** Applied to the scrolling body under the header. */
  bodyClassName?: string
  testId?: string
  children: React.ReactNode
}

export function RouteDialog({
  title,
  description,
  closeLabel,
  standalone = false,
  fallbackHref = '/app/projects',
  bodyClassName,
  testId,
  children,
}: RouteDialogProps): JSX.Element {
  const router = useRouter()
  const [open, setOpen] = React.useState(true)
  const left = React.useRef(false)

  const leave = React.useCallback(() => {
    if (left.current) return
    left.current = true
    if (standalone || (typeof window !== 'undefined' && window.history.length <= 1)) router.push(fallbackHref)
    else router.back()
  }, [standalone, fallbackHref, router])

  React.useEffect(() => {
    if (open) return
    const timer = setTimeout(leave, EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [open, leave])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
      <DialogContent
        closeLabel={closeLabel}
        data-testid={testId}
        // Focus lands on the panel, not on the close X: a ring around the X on
        // every open reads as the dialog asking to be closed. `PageSheet` does
        // the same. Tab still reaches every control in order.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        onAnimationEnd={(event) => {
          if (!open && event.target === event.currentTarget) leave()
        }}
        className="flex max-h-[min(54rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 outline-none sm:max-w-2xl"
      >
        <DialogHeader className="border-b px-5 pt-5 pb-4 pr-14 text-left sm:px-6">
          <DialogTitle className="text-lg font-semibold tracking-tight">{title}</DialogTitle>
          {description ? (
            <DialogDescription asChild>
              <div>{description}</div>
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        <div className={cn('scroll-fade-bottom min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6', bodyClassName)}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  )
}
