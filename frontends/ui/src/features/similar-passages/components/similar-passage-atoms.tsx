'use client'

/**
 * The atoms „Im Büro behandelt" is drawn from: the rail's frame, a project's
 * heading, and one passage as a quotation the reader opens. The panel composes
 * these and the kit's own (`ProjectInitialsTile`, `ProjectClosedChip`), so its
 * shapes live here once.
 */

import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { cn } from '@/lib/utils'

/**
 * The rail beside the document: a column on a real screen, a band above the
 * document on a phone. The same footprint the citation viewer's Fundstellen
 * rail takes, so swapping one for the other does not move the document.
 */
export function SimilarRail({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section
      aria-label={label}
      data-testid="similar-passages"
      className={cn('flex max-h-[40dvh] min-h-0 max-w-full shrink-0 flex-col gap-3 md:max-h-none md:w-80', className)}
    >
      {children}
    </section>
  )
}

/** The scrolling list under the rail's head. */
export function SimilarList({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pb-1 pr-1">{children}</div>
  )
}

/**
 * Where a group's passages are: a project (its initials, its name, what is true
 * of it) or the Büroablage. `tile` is the left edge, so the eye scans a fixed
 * column of places before it reads a word.
 */
export function SimilarGroupHeading({
  tile,
  name,
  meta,
}: {
  tile: ReactNode
  name: string
  meta?: ReactNode
}): JSX.Element {
  return (
    <h3 className="flex min-w-0 items-center gap-2.5">
      {tile}
      <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={name}>
        {name}
      </span>
      {meta}
    </h3>
  )
}

/** A quiet word after a project's name: „Dieses Projekt". */
export function SimilarGroupNote({ children }: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-xs text-muted-foreground">{children}</span>
}

/**
 * One passage, as a quotation: the words on top, where they are written below
 * (document and Fassung, then the page, which never truncates), and an „Öffnen"
 * that says what pressing does. The whole card opens the document at the
 * passage. `current` marks the one on the
 * stage, as the Fundstellen rail marks the one being read.
 */
export const SimilarPassageButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    current?: boolean
    quote: string
    /** The document and its Fassung; truncates first, so `page` always shows. */
    source: ReactNode
    page?: string | null
    openLabel: string
  }
>(function SimilarPassageButton({ current, quote, source, page, openLabel, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-current={current ? 'true' : undefined}
      data-similar-passage=""
      className={cn(
        'group/passage flex w-full flex-col gap-1.5 rounded-md border-l-2 py-1.5 pl-3 pr-2 text-left outline-none',
        'transition-colors duration-quick ease-out motion-reduce:transition-none',
        FOCUS_RING,
        current
          ? 'border-foreground bg-accent/70'
          : 'border-border hover:border-foreground/60 hover:bg-accent/40',
        className
      )}
      {...props}
    >
      <span className="line-clamp-4 text-[13px] leading-relaxed text-foreground">„{quote}“</span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{source}</span>
        {page && <span className="shrink-0 tabular-nums">{page}</span>}
        {!current && (
          // Not on the open one: it is open already, and saying so again would cost the line its page.
          <span
            aria-hidden
            className="hidden shrink-0 items-center gap-0.5 font-medium text-foreground/70 group-hover/passage:inline-flex group-focus-visible/passage:inline-flex pointer-coarse:inline-flex"
          >
            {openLabel}
            <ArrowUpRight className="size-3" />
          </span>
        )}
      </span>
    </button>
  )
})
