/**
 * The report's outline — where the reader is, and where else they could be.
 *
 * ## Why it is a bar and not a rail
 *
 * The research panel takes half the window, and the report column inside it is
 * roughly 580–670px once the panel's padding is off. A rail down the side at
 * the ~200px an outline needs to be readable would take nearly a third of that
 * and leave the prose in a column too narrow for the tables and the long
 * German compounds this content is made of — and on mobile, where the panel is
 * the whole screen but only ~360px of it, a rail is not expressible at all. So
 * the outline runs ACROSS the report instead of beside it, as a single sticky
 * row that opens into a list.
 *
 * Sticky, because an outline that scrolls away is an outline you have to
 * scroll back up to use, which is the problem it was added to solve. Collapsed
 * by default, because an open list of a dozen entries would push the report's
 * first paragraph off the screen for a reader who arrived to read, not to
 * navigate. And the collapsed row is not merely a handle: it prints the
 * section the reader is currently in, so the "you are here" half of the
 * feature is delivered without opening anything.
 *
 * Rejected: a rail (above); a floating button over the text (hides prose,
 * hides itself, and needs a second surface to open into); and an
 * always-expanded list at the top (costs the first screen of every report and
 * cannot mark the current section once it has scrolled away).
 */

'use client'

import { type FC, type RefObject, useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, List } from 'lucide-react'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { scrollToAnchor } from '@/shared/components/MarkdownRenderer/anchor-context'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import type { ReportOutlineEntry } from '../lib/report-outline'

interface ReportOutlineProps {
  /** The headings to offer, in document order. */
  entries: ReportOutlineEntry[]
  /**
   * The report's scroll container, used as the intersection root so "in view"
   * means in view of the panel rather than of the window.
   */
  scrollRootRef?: RefObject<HTMLElement | null>
}

/**
 * Only a heading in the top third of the report counts as the one being read.
 * Without the bottom inset, every heading on screen would qualify and the mark
 * would sit on whichever section happened to be lowest.
 */
const ACTIVE_BAND = '0px 0px -66% 0px'

export const ReportOutline: FC<ReportOutlineProps> = ({ entries, scrollRootRef }) => {
  const t = useTranslations('research')
  const [isOpen, setIsOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const listId = useId()

  // The ids, as one string, so the observer is rebuilt when the report changes
  // and not on every render of an unchanged one.
  const idsKey = useMemo(() => entries.map((entry) => entry.id).join('\n'), [entries])

  useEffect(() => {
    // happy-dom and jsdom either lack the observer or implement it inertly. No
    // observer means no active mark — the list still navigates, which is the
    // part that has to work everywhere.
    if (typeof IntersectionObserver === 'undefined') return

    const order = idsKey.split('\n')
    const headings = order
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)
    if (headings.length === 0) return

    const inBand = new Set<string>()
    const observer = new IntersectionObserver(
      (observed) => {
        for (const entry of observed) {
          const id = (entry.target as HTMLElement | undefined)?.id
          if (!id) continue
          if (entry.isIntersecting) inBand.add(id)
          else inBand.delete(id)
        }
        const current = order.find((id) => inBand.has(id))
        // Mid-section no heading is in the band at all: the reader has not
        // left the section they were in, so the mark stays. Above the first
        // heading nothing has been read yet, and the first section is the
        // honest answer.
        setActiveId((previous) => current ?? previous ?? order[0] ?? null)
      },
      { root: scrollRootRef?.current ?? null, rootMargin: ACTIVE_BAND, threshold: 0 }
    )
    for (const heading of headings) observer.observe(heading)
    return () => observer.disconnect()
  }, [idsKey, scrollRootRef])

  if (entries.length === 0) return null

  const activeEntry = entries.find((entry) => entry.id === activeId) ?? null
  const summary = isOpen
    ? t('reportOutline.sectionCount', { count: entries.length })
    : (activeEntry?.text ?? t('reportOutline.sectionCount', { count: entries.length }))

  return (
    <nav
      aria-label={t('reportOutline.label')}
      className="sticky top-0 z-10 shrink-0 border-b bg-background"
      data-testid="report-outline"
    >
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={listId}
        title={isOpen ? t('reportOutline.hide') : t('reportOutline.show')}
        className={cn(
          // The sticky bar that opens the report's table of contents: full width,
          // alone in its band, and 36px. Padding, not a catchment — an overhang
          // would reach past the sticky band's own border into the report text
          // scrolling underneath it.
          'flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-sm outline-none pointer-coarse:py-3',
          'text-muted-foreground hover:text-foreground',
          FOCUS_RING_INSET
        )}
      >
        <List className="size-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{t('reportOutline.title')}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
            isOpen && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>

      {/* Capped and scrollable: a twenty-entry report would otherwise open a
          list taller than the report it sits on top of. */}
      <ol id={listId} hidden={!isOpen} className="max-h-[50vh] list-none overflow-y-auto pb-2 pl-0">
        {entries.map((entry) => {
          const isActive = entry.id === activeId
          return (
            <li key={entry.key}>
              <a
                href={`#${entry.id}`}
                aria-current={isActive ? 'location' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  // Honours `prefers-reduced-motion`, and is the same jump the
                  // report's own in-page links make.
                  scrollToAnchor(entry.id)
                  setActiveId(entry.id)
                  // The list did its job; give the screen back to the report.
                  setIsOpen(false)
                }}
                className={cn(
                  // Square on the LEFT, because that edge carries the
                  // „you are here" rule: a 2px left border on a `rounded-md`
                  // box is drawn around the corner radius at both ends, so the
                  // mark rendered as a parenthesis beside the section title
                  // rather than as a straight rule.
                  // The outline is a stack of jump links and on a phone it is the
                  // only way to move around a long report. At `py-1` each row was
                  // 28px, so the list needed a precise tap on every entry —
                  // padding, not a catchment, because the rows are neighbours.
                  'block truncate rounded-r-md border-l-2 py-1 pr-2 text-sm outline-none pointer-coarse:py-3',
                  entry.level === 3 ? 'pl-6' : 'pl-3',
                  isActive
                    ? 'border-l-foreground font-medium text-foreground'
                    : 'border-l-transparent text-muted-foreground hover:text-foreground',
                  FOCUS_RING_INSET
                )}
              >
                {entry.text}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
