'use client'

/**
 * Project surface atoms — the parts every "a project, listed" surface is built
 * from.
 *
 * **Read this before adding another project surface.** The project card
 * (`ProjectCard`) is a staple of the design language, not one page's component:
 * the raised white plate on a subtle surface, the truncating name that opens
 * Chat through a stretched link, the status chip, the brief line, the meta strip
 * with a settings gear. A new surface that needs "a project, listed" COMPOSES
 * these atoms — or, better, uses `ProjectCard` itself. It does not hand-roll a
 * second card that happens to look similar; two lookalikes drift on the first
 * token retune, and the divergence shows up as a page where one card has a
 * different corner radius, a different hover lift, or a timestamp that means
 * something else.
 *
 * The atoms exist so a genuinely different ARRANGEMENT (the dense list row) can
 * still be made of the same material as the card.
 *
 * The card's SHAPE is not here: the raised white block on a subtler tray with a
 * footer tab is the product's card, and it already has a primitive —
 * `components/ui/raised-card.tsx` (`RaisedCard` / `RaisedCardBody` /
 * `RaisedCardFooter`). This file holds what is specific to a PROJECT on that
 * shape. Adding a `rounded-b-[10px] bg-card shadow-xs` of its own here would
 * have been the fifth hand-rolled copy of that geometry, which is the exact
 * drift `raised-card.tsx` was written to stop.
 *
 * Each atom owns a single decision, and the two that carry meaning rather than
 * styling are the ones worth knowing about:
 *
 *   - {@link ProjectActivity} owns the "whose timestamp is this?" rule. The
 *     viewer's own last message and the project's last profile write are two
 *     different facts; this is the only place that decides which is on screen
 *     and labels it accordingly, so no surface can quietly imply the wrong one.
 *   - {@link ProjectOpenLink} owns the stretched-link mechanics. Every project
 *     surface is one big click target with independently focusable controls
 *     layered above it; getting that wrong produces nested anchors, which is
 *     invalid HTML and breaks keyboard navigation.
 *
 * See `docs/design/project-surfaces.md` for the inventory and the rule.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { Clock3, FileText, LayoutDashboard, Mail, MessageSquare } from 'lucide-react'
import { useMemo } from 'react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { projectInitials } from '@/features/projects/lib/project-initials'
import { projectNameTail } from '@/features/projects/lib/project-name'
import type { Project } from '@/lib/db/schema'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * The project name as the surface's primary link, stretched over the whole
 * nearest positioned ancestor. Anything else clickable on the surface must sit
 * above it (`relative z-10`) rather than inside it — see {@link ProjectOverviewLink}.
 */
export function ProjectOpenLink({
  project,
  className,
}: {
  project: Pick<Project, 'id' | 'name'>
  className?: string
}): JSX.Element {
  const t = useTranslations('projects')
  return (
    <Link
      href={`/app/projects/${project.id}/chat`}
      aria-label={t('card.open', { name: project.name })}
      className={cn(
        // `block min-w-0`: the name is a one-line `MiddleTruncate`, and that can
        // only shrink inside a box that is allowed to be narrower than its text.
        //
        // Inset, not offset: the ring draws on the `::after` sheet covering the
        // whole card, and an offset ring would be sliced off by the card's own
        // `overflow-hidden` — this is the documented inset exception at the
        // documented `/60` alpha, not the old `/50` third recipe.
        'block min-w-0 after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/60',
        className,
      )}
    >
      {/* Cut in the MIDDLE: what tells two projects of one office apart is the
          end of the name ("… Neubau Gästetrakt"), the part an end ellipsis
          throws away first, and on a phone that is most names. */}
      {/* `whitespace-pre` on the two halves: each is its own flex item, and a
          flex item drops the space at its edge, which is exactly where the cut
          falls ("Wohnbau" + "Seestadt" would read "WohnbauSeestadt"). */}
      <MiddleTruncate
        text={project.name}
        tail={projectNameTail(project.name)}
        className="[&>span]:whitespace-pre"
      />
    </Link>
  )
}

/**
 * The brief line.
 *
 * `fallback` is on for a card, where the shared invitation ("add documents and a
 * brief") is a crafted empty state and there is room for it. It is off for a
 * dense list, where an invitation stops being one: repeated verbatim down
 * fifteen rows it becomes the longest line on the page, and the rows carrying
 * the LEAST information end up shouting the loudest. With it off, a project
 * without a brief simply has no second line, which is the truth, quietly.
 */
export function ProjectSummaryLine({
  project,
  fallback = true,
  className,
}: {
  project: Pick<Project, 'profileDisplay'>
  fallback?: boolean
  className?: string
}): JSX.Element | null {
  const t = useTranslations('projects')
  const summary = project.profileDisplay?.summary?.trim() || (fallback ? t('card.summaryFallback') : '')
  if (!summary) return null
  return <p className={cn('truncate text-xs text-muted-foreground', className)}>{summary}</p>
}

/**
 * When this project was last touched, and BY WHOM — the one place that decides.
 *
 * `activityAt` is the viewer's own last message in the project. When it is
 * present the surface says so ("You were last here"); when it is absent the
 * timestamp falls back to the project's own last movement (profile write, then
 * creation) under the neutral "Last activity" label. The two are never merged
 * into one ambiguous number, and the icon follows the label — a speech bubble
 * for a conversation, a clock for a project's own clock.
 */
export function ProjectActivity({
  project,
  activityAt,
  showLabel = true,
  compact = false,
  className,
}: {
  project: Pick<Project, 'profileUpdatedAt' | 'createdAt'>
  /** ISO timestamp of the VIEWER's own last activity, when they have any. */
  activityAt?: string
  /** `false` renders the label for assistive tech only (dense surfaces). */
  showLabel?: boolean
  /**
   * The icon stays and the words go to assistive tech and the tooltip: for a
   * card footer that also carries a link, where „Zuletzt hier gearbeitet“ plus
   * the time plus the link is wider than a card on a phone. The icon still says
   * whose clock this is (a speech bubble for the viewer's own, a clock for the
   * project's).
   */
  compact?: boolean
  className?: string
}): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()

  const fallback = project.profileUpdatedAt ?? project.createdAt
  const iso = useMemo(
    () => (activityAt ? new Date(activityAt).toISOString() : new Date(fallback).toISOString()),
    [activityAt, fallback],
  )

  const label = activityAt ? t('card.yourActivity') : t('card.lastActivity')
  const Icon = activityAt ? MessageSquare : Clock3

  return (
    <>
      {showLabel ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className={cn(compact && 'sr-only')}>{label}</span>
        </span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
      <time
        dateTime={iso}
        title={`${label}: ${formatAbsoluteTime(iso, locale)}`}
        suppressHydrationWarning
        className={cn('truncate text-xs tabular-nums text-muted-foreground', className)}
      >
        {formatRelativeTime(iso, locale)}
      </time>
    </>
  )
}

/** Ingested document count, pluralized. */
export function ProjectDocCount({ count, className }: { count: number; className?: string }): JSX.Element {
  const t = useTranslations('projects')
  return (
    <span className={cn('flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground', className)}>
      <FileText className="size-3.5 shrink-0" aria-hidden />
      {t('card.docLabel', { count, unit: count === 1 ? t('card.document') : t('card.documents') })}
    </span>
  )
}

/**
 * The shortcut to the project's Übersicht, layered ABOVE the stretched open-link
 * rather than nested inside it — two anchors, never one inside the other.
 *
 * The destination is the project's overview (`/settings`, titled „Übersicht“ in
 * the project's own navigation): where it stands, its brief, its documents and
 * the setup behind them. It used to wear a gear, which promised a settings
 * form and hid the one page that answers „wo steht dieses Projekt“. The icon is
 * the one the navigation gives that destination (`PROJECT_SETTINGS_SECTION`).
 *
 * 44px on a touch pointer: on a row it is the only control besides the
 * stretched link covering everything else, and a neighbour sits beside it, so
 * it grows rather than overhanging (`touch-target` would overlap the row's own
 * link, and the later element in the DOM would win the tap).
 */
export function ProjectOverviewLink({
  project,
  showLabel = false,
  className,
}: {
  project: Pick<Project, 'id' | 'name'>
  /** Spell the destination out beside the icon (the card has the room, a row does not). */
  showLabel?: boolean
  className?: string
}): JSX.Element {
  const t = useTranslations('projects')
  return (
    <Link
      href={`/app/projects/${project.id}/settings`}
      aria-label={t('card.overviewAria', { name: project.name })}
      className={cn(
        'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-lg text-muted-foreground transition-colors duration-quick ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none motion-reduce:transition-none',
        showLabel ? 'h-8 px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:px-3' : 'size-8 pointer-coarse:size-11',
        FOCUS_RING,
        className,
      )}
    >
      <LayoutDashboard className="size-3.5" aria-hidden />
      {showLabel && <span>{t('card.overview')}</span>}
    </Link>
  )
}

/**
 * Mail waiting in the project's E-Mail-Eingang (ADR-0134): „2 E-Mails warten“,
 * a link straight into it, layered above `ProjectOpenLink` (`relative z-10`)
 * the way {@link ProjectOverviewLink} is. Rendered only with a count above
 * zero, and only for a reader who may file the project's mail: the caller's
 * count comes from the list operation, filtered per reader, so it is honest in
 * the `project-surfaces.md` sense. Quiet ink, never a badge colour.
 */
export function ProjectMailWaiting({
  project,
  count,
  className,
}: {
  project: Pick<Project, 'id' | 'name'>
  count: number
  className?: string
}): JSX.Element | null {
  const t = useTranslations('projects')
  if (!Number.isFinite(count) || count <= 0) return null
  return (
    <Link
      href={`/app/projects/${encodeURIComponent(project.id)}/files/mail`}
      aria-label={t('card.mailWaitingAria', { count, name: project.name })}
      data-testid="project-mail-waiting"
      className={cn(
        'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors duration-quick ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none motion-reduce:transition-none pointer-coarse:h-11 pointer-coarse:px-3',
        FOCUS_RING,
        className,
      )}
    >
      <Mail className="size-3.5" aria-hidden />
      <span className="tabular-nums">{t('card.mailWaiting', { count })}</span>
    </Link>
  )
}

/**
 * Initials tile — the left edge of a dense list, so a scan has a fixed column to
 * index rows by. Decorative: the name is right beside it, so it carries no text
 * for assistive tech.
 */
export function ProjectInitialsTile({
  project,
  className,
}: {
  project: Pick<Project, 'name'>
  className?: string
}): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold tracking-wide text-muted-foreground transition-colors duration-quick ease-out group-hover:bg-accent group-hover:text-foreground motion-reduce:transition-none',
        className,
      )}
    >
      {projectInitials(project.name)}
    </span>
  )
}
