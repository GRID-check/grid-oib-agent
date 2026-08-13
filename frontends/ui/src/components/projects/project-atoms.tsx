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

import Link from 'next/link'
import { Clock3, FileText, MessageSquare, Settings } from 'lucide-react'
import { useMemo } from 'react'
import { projectInitials } from '@/features/projects/lib/project-initials'
import type { Project } from '@/lib/db/schema'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * The project name as the surface's primary link, stretched over the whole
 * nearest positioned ancestor. Anything else clickable on the surface must sit
 * above it (`relative z-10`) rather than inside it — see {@link ProjectSettingsLink}.
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
        'after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50',
        className,
      )}
    >
      {project.name}
    </Link>
  )
}

/** The brief line, falling back to the shared invitation when a project has none. */
export function ProjectSummaryLine({
  project,
  className,
}: {
  project: Pick<Project, 'profileDisplay'>
  className?: string
}): JSX.Element {
  const t = useTranslations('projects')
  const summary = project.profileDisplay?.summary?.trim() || t('card.summaryFallback')
  return <p className={cn('truncate text-[12.5px] text-muted-foreground', className)}>{summary}</p>
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
  className,
}: {
  project: Pick<Project, 'profileUpdatedAt' | 'createdAt'>
  /** ISO timestamp of the VIEWER's own last activity, when they have any. */
  activityAt?: string
  /** `false` renders the label for assistive tech only (dense surfaces). */
  showLabel?: boolean
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
          {label}
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
 * The settings shortcut. Layered ABOVE the stretched open-link rather than
 * nested inside it — two anchors, never one inside the other.
 */
export function ProjectSettingsLink({
  project,
  className,
}: {
  project: Pick<Project, 'id' | 'name'>
  className?: string
}): JSX.Element {
  const t = useTranslations('projects')
  return (
    <Link
      href={`/app/projects/${project.id}/settings`}
      aria-label={t('card.settingsAria', { name: project.name })}
      className={cn(
        'relative z-10 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
        className,
      )}
    >
      <Settings className="size-3.5" aria-hidden />
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
        'grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-[11px] font-semibold tracking-wide text-muted-foreground transition-colors duration-200 ease-out group-hover:bg-accent group-hover:text-foreground motion-reduce:transition-none',
        className,
      )}
    >
      {projectInitials(project.name)}
    </span>
  )
}
