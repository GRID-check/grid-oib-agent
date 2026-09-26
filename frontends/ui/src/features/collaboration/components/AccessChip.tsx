'use client'

/**
 * The access indicator (spec SH-18) — the always-visible answer to "who can read
 * what I am writing", shown wherever a conversation is listed or opened. It closes
 * the "Privater Workspace" chip the click-dummy left undesigned
 * (`docs/design/click-dummy-overhaul-spec.md` §2.3).
 *
 * Four states, and the distinction between them is carried by **icon + word**,
 * never by colour — both because the design language reserves chroma for
 * provenance signals and because this chip appears in dense lists where a colour
 * dot would be unreadable:
 *
 *   | State                  | Glyph        | Reads as                     |
 *   |------------------------|--------------|------------------------------|
 *   | `private`, nobody else | closed lock  | nobody but me                |
 *   | `private` + N people   | share arrows | a named, deliberate audience |
 *   | `project`              | people       | a group I did not enumerate  |
 *   | `organization`         | building     | the whole company            |
 *
 * The lock is reserved for the *actually* private case. A shared thread wearing a
 * padlock would be a lie the reader has to click to discover, so the shared state
 * deliberately does not look like one.
 *
 * Presentational and fetch-free: it takes a visibility and a count, so a list row
 * can render it from data it already has instead of opening a request per row.
 */

import type { JSX } from 'react'
import { Building2, Lock, Share2, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import type { ResourceAccessEntry, ResourceVisibility } from '@/lib/sharing/types'
import { cn } from '@/lib/utils'

/**
 * How many people hold access *by name* besides the reader — the number the
 * "Geteilt mit N" state reports.
 *
 * Counts only the explicit grants (`creator`, `grant`); visibility-derived rows are
 * the blanket rule, which the chip states as `Projekt` / `Organisation` instead.
 * Lives here, with the chip that renders it, so the toolbar chip and the overview
 * cannot disagree about the number.
 */
export function namedAudienceCount(
  entries: readonly ResourceAccessEntry[],
  viewerUserId?: string | null,
): number {
  return entries.filter(
    (entry) =>
      entry.person.userId !== viewerUserId &&
      (entry.reason === 'grant' || entry.reason === 'creator'),
  ).length
}

export interface AccessChipProps {
  visibility: ResourceVisibility
  /**
   * How many people hold access besides the reader. Only consulted while the
   * resource is `private`, where it is the difference between "nobody" and "three
   * named colleagues" — under `project`/`organization` the blanket rule is the
   * more honest statement, and a count there would understate the audience.
   */
  sharedWith?: number
  /** `sm` for list rows and toolbars (default), `md` where it stands alone. */
  size?: 'sm' | 'md'
  className?: string
}

const ICONS: Record<'private' | 'shared' | 'project' | 'organization', LucideIcon> = {
  private: Lock,
  shared: Share2,
  project: Users,
  organization: Building2,
}

export function AccessChip({
  visibility,
  sharedWith = 0,
  size = 'sm',
  className,
}: AccessChipProps): JSX.Element {
  const t = useTranslations('collaboration')

  const count = Number.isFinite(sharedWith) ? Math.max(0, Math.floor(sharedWith)) : 0
  const state =
    visibility === 'private' ? (count > 0 ? 'shared' : 'private') : visibility
  const Icon = ICONS[state]

  const label =
    state === 'shared'
      ? count === 1
        ? t('sharing.chip.sharedOne')
        : t('sharing.chip.sharedMany', { count })
      : t(`sharing.chip.${state}`)

  return (
    <Chip
      // role="img" + a composed aria-label so the state is announced as one
      // labelled indicator ("Zugriff: Mit 3 Personen geteilt") instead of a bare
      // adjective floating next to the thread title.
      role="img"
      aria-label={t('sharing.chip.ariaLabel', { label })}
      data-testid="access-chip"
      data-visibility={visibility}
      data-state={state}
      // Private is the quietest fill; every shared state gets the hairline
      // outline, so "someone else can read this" is a visible step up in
      // presence without spending colour on it.
      variant={state === 'private' ? 'muted' : 'outline'}
      size={size}
      className={cn('font-medium', className)}
    >
      <Icon aria-hidden />
      {label}
    </Chip>
  )
}
