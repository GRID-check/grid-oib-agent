'use client'

/**
 * The one back control for pages that live OUTSIDE the project shell — the org
 * Archiv, Organisation, Platform, Inbox, Profil. Those pages drop the project
 * rail, so this link is the whole way out, and each of them used to hard-code
 * its own guess at where "back" is (`/app/projects`, or the reader's active
 * project). For most readers that guess was wrong: they open the Archiv from
 * the ⌘K palette or the user menu, from whatever page they were working on, and
 * landing somewhere they had not been reads as "back did not work".
 *
 * So it isn't a guess any more. The tab's return trail
 * (`lib/navigation/return-trail`) knows the location one step back and, when
 * that page named itself, what to call it: coming out of a project, the label is
 * the PROJECT'S NAME — "Zurück zu Stadthaus Wien" — because leaving that project
 * is what the reader is undoing. For everything else `describeAppPath` names the
 * route from the SAME dictionary entry that destination's nav item uses, so the
 * back control and the rail cannot drift apart. Navigation then goes through
 * `history.back()` when that one step *is* the destination, so the reader gets
 * the page they left *as they left it*: scroll position, open panels, and Next's
 * cached payload, none of which a fresh push to the same URL restores.
 *
 * Tabbed shells (Organisation, Platform, Inbox, Profil) are one place, not a
 * stack of submenus. The trail already collapses those siblings; if an older
 * trail still has them stacked, this control follows the href out of the shell
 * instead of walking one tab at a time.
 *
 * The server-resolved `fallbackHref`/`fallbackLabel` still carry the case with
 * no trail to read — a link opened in a new tab, a restored session, a page
 * entered directly — so this control always points somewhere.
 */

import { useEffect, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { describeAppPath } from '@/lib/navigation/describe-path'
import { previousVisit, readTrail, type TrailEntry } from '@/lib/navigation/return-trail'

export interface BackLinkProps {
  /** Where to go when the tab has no trail (direct link, new tab, reload of a first page). */
  fallbackHref: string
  /** Label for that fallback, resolved by the page that knows what it is. */
  fallbackLabel: string
  className?: string
}

export function BackLink({ fallbackHref, fallbackLabel, className }: BackLinkProps): JSX.Element {
  const pathname = usePathname()
  const router = useRouter()
  const tNav = useTranslations('nav')
  const tCollaboration = useTranslations('collaboration')
  const tCommon = useTranslations('common')

  // Read after mount, never during render: `sessionStorage` does not exist on
  // the server, so the first client render has to match the server's fallback.
  const [previous, setPrevious] = useState<TrailEntry | null>(null)
  useEffect(() => {
    setPrevious(pathname ? previousVisit(readTrail(), pathname) : null)
  }, [pathname])

  const described = previous ? describeAppPath(previous.path) : null
  const label = !previous
    ? fallbackLabel
    : previous.label
      ? // The page named itself while the reader was on it — a project name, not
        // a section noun. "Zurück zu Stadthaus Wien" beats "Zurück zu Dateien":
        // leaving a project is what the reader is undoing.
        tNav('backTo', { label: previous.label })
      : described
        ? tNav('backTo', {
            label:
              described.namespace === 'collaboration'
                ? tCollaboration(described.key)
                : tNav(described.key),
          })
        : // A real page we cannot name (a route with no nav entry): go back to
          // it, but say only "Back" rather than inventing a name for it.
          tCommon('actions.back')

  const handleClick = (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>): void => {
    if (!previous) return
    // Leave modified clicks (new tab/window, download) to the browser, which is
    // why this stays an anchor with a real href rather than a button.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    if (typeof window !== 'undefined' && window.history.length <= 1) return
    // history.back() is only safe when the trail's destination is the page
    // one step behind. Skipping a settings tab means the href is two or more
    // history entries away — follow the link instead of landing on Models.
    const trail = readTrail()
    const immediate = trail.length >= 2 ? trail[trail.length - 2] : null
    if (immediate && immediate.path !== previous.path) return
    event.preventDefault()
    router.back()
  }

  return (
    <BackControl
      href={previous?.path ?? fallbackHref}
      label={label}
      onClick={handleClick}
      className={className}
      testId="back-link"
    />
  )
}

/**
 * "Back to <somewhere>", as a shape rather than as a destination.
 *
 * Split out of {@link BackLink} because a second thing needed to look like it
 * and had no route to give it: going up a level inside the Dateien folder tree,
 * where "back" is a folder, not a page. Two controls that mean the same thing
 * and are drawn by two files drift on the first token retune — so the shell is
 * one component and the callers bring their own answer to "back to what".
 *
 * It renders an anchor when there is an `href`, so a page destination keeps
 * middle-click and copy-link, and a button when the destination is not a route
 * of its own.
 */
export function BackControl({
  href,
  label,
  onClick,
  className,
  testId,
}: {
  /** A real route, or omitted when the destination is not addressable on its own. */
  href?: string
  label: string
  onClick?: (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => void
  className?: string
  testId?: string
}): JSX.Element {
  // 36px, and it is the one way out — on a phone, where there is no rail beside
  // it to fall back on, that matters more than anywhere else.
  const shell = cn(
    'text-muted-foreground hover:bg-accent/60 hover:text-foreground group inline-flex w-fit items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-sm pointer-coarse:py-2.5 pointer-coarse:pl-2.5 pointer-coarse:pr-4',
    'transition-[color,background-color,transform] duration-quick ease-out active:scale-[0.98] motion-reduce:transition-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    className
  )

  // A raised disc rather than a bare glyph: the same "catches the light"
  // treatment the empty-state icon uses, so the one way out reads as a control
  // instead of a caption.
  const body = (
    <>
      <span
        aria-hidden
        className="bg-card border-border/80 shadow-2xs flex size-6 shrink-0 items-center justify-center rounded-full border"
      >
        <ArrowLeft className="size-3.5" />
      </span>
      {label}
    </>
  )

  if (href === undefined) {
    return (
      <button type="button" onClick={onClick} data-testid={testId} className={shell}>
        {body}
      </button>
    )
  }

  return (
    <Link href={href} onClick={onClick} data-testid={testId} className={shell}>
      {body}
    </Link>
  )
}
