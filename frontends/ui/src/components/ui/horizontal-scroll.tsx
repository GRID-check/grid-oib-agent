'use client'

/**
 * A horizontal scroller that shows which way there is more.
 *
 * A wide table or drawing in a narrow column scrolls sideways, and on a phone
 * nothing said so: the comparison table's third column ended mid-letter at the
 * card edge and read as if it were not there. The edge that hides content
 * fades out, so the cut looks like a cut and not like the end.
 *
 * A mask, not an overlay: an overlay has to be painted in the colour of the
 * surface under it, and this sits on cards, answers and the page in both
 * themes. `mask-image` fades whatever is there.
 */

import { type HTMLAttributes, type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/** How far into the content each fade reaches. */
const FADE_PX = 28

interface Overflow {
  start: boolean
  end: boolean
}

const maskFor = ({ start, end }: Overflow): string | undefined => {
  if (!start && !end) return undefined
  const from = start ? `transparent, black ${FADE_PX}px` : 'black, black'
  const to = end ? `black calc(100% - ${FADE_PX}px), transparent` : 'black, black'
  return `linear-gradient(to right, ${from}, ${to})`
}

export interface HorizontalScrollProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /**
   * What is being scrolled, in the reader's language („Tabelle, seitlich
   * scrollbar"). Required: when the content overflows, the scroller becomes a
   * focusable, named region so a keyboard user can reach it and scroll it with
   * the arrow keys. A mouse or a touch scrolls it without focus; a keyboard
   * cannot, and the column that did not fit was simply out of reach.
   */
  'aria-label': string
}

export function HorizontalScroll({
  children,
  className,
  style,
  'aria-label': label,
  ...props
}: HorizontalScrollProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const start = element.scrollLeft > 1
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setOverflow((previous) => (previous.start === start && previous.end === end ? previous : { start, end }))
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    if (typeof ResizeObserver === 'undefined') return () => element.removeEventListener('scroll', update)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const mask = maskFor(overflow)
  // Only a scroller that actually scrolls is a stop in the tab order and a
  // landmark: every table in an answer as a named region would bury the ones
  // that need the keyboard among dozens that do not.
  const scrollable = overflow.start || overflow.end
  return (
    <div
      ref={ref}
      role={scrollable ? 'region' : undefined}
      tabIndex={scrollable ? 0 : undefined}
      aria-label={scrollable ? label : undefined}
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
      className={cn('overflow-x-auto', className)}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      {...props}
    >
      {children}
    </div>
  )
}
