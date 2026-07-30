'use client'

/**
 * The at-a-glance overview: who is in this conversation, as an overlapping avatar
 * stack that opens the full access panel.
 *
 * Three decisions worth keeping:
 *
 *   1. **Solo threads render nothing.** A single-participant private chat is the
 *      overwhelmingly common case, and a "1 person" stack there is collaboration
 *      furniture charging rent on a surface where nothing is being collaborated on.
 *      No strip is the correct answer, not an empty one.
 *   2. **Owners first, then the role ladder, then name.** The order must not depend
 *      on when someone was invited or where the server happened to put them, or the
 *      faces move under the reader between renders and stop being recognisable.
 *   3. **One button, not N buttons.** The whole strip is a single control that opens
 *      the overview; the per-avatar tooltips hang off plain `<span>`s inside it.
 *      Nesting a button per face inside a button is invalid HTML and would make the
 *      strip a tab-stop minefield — the names are reachable for keyboard and screen
 *      reader users in the panel the button opens, which is also where they are
 *      actionable.
 */

import { Fragment } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import type { DirectoryPerson, ResourceAccessEntry, ResourceRole } from '@/lib/sharing/types'
import { cn } from '@/lib/utils'
import { avatarColorStyle, personInitials } from '../lib/avatar-color'

/** Strongest first — the order the strip and the overview both sort by. */
const ROLE_RANK: Record<ResourceRole, number> = { owner: 0, collaborator: 1, viewer: 2 }

/** Faces shown before the rest collapse into a `+N` bubble. */
const DEFAULT_MAX_VISIBLE = 4

const SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
} as const

export interface PersonAvatarProps {
  person: DirectoryPerson
  size?: keyof typeof SIZES
  className?: string
}

/**
 * A person's avatar: their photo when we have one, otherwise their initials on the
 * colour their user id always maps to (`../lib/avatar-color`). Shared with the
 * roster rows and the invite picker so one colleague is one colour everywhere.
 */
export function PersonAvatar({ person, size = 'md', className }: PersonAvatarProps): JSX.Element {
  return (
    <Avatar className={cn(SIZES[size], className)} data-testid="person-avatar">
      {person.profilePictureUrl && <AvatarImage src={person.profilePictureUrl} alt="" />}
      <AvatarFallback
        className="font-semibold"
        // Inline because the hue is derived at runtime — Tailwind can only emit
        // classes it saw at build time. Both values are `color-mix()` against
        // theme tokens, so dark mode is covered without a second palette.
        style={avatarColorStyle(person.userId)}
      >
        {personInitials(person.name)}
      </AvatarFallback>
    </Avatar>
  )
}

/** Sort a roster the way both the strip and the overview present it. */
export function sortByRoleThenName(entries: readonly ResourceAccessEntry[]): ResourceAccessEntry[] {
  return [...entries].sort(
    (a, b) =>
      ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.person.name.localeCompare(b.person.name),
  )
}

export interface ParticipantStripProps {
  entries: readonly ResourceAccessEntry[]
  /** Marks the reader's own face, so the tooltip can say "you". */
  currentUserId?: string | null
  /** Faces before the `+N` bubble. Defaults to 4. */
  maxVisible?: number
  /** Opens the access overview. Omit to render the strip as a plain indicator. */
  onOpen?: () => void
  className?: string
}

export function ParticipantStrip({
  entries,
  currentUserId = null,
  maxVisible = DEFAULT_MAX_VISIBLE,
  onOpen,
  className,
}: ParticipantStripProps): JSX.Element | null {
  const t = useTranslations('collaboration')

  // Solo — nothing to show. See note 1 above.
  if (entries.length <= 1) return null

  const ordered = sortByRoleThenName(entries)
  const visible = ordered.slice(0, Math.max(1, maxVisible))
  const overflow = ordered.length - visible.length

  const faces = (
    <Fragment>
      {visible.map((entry) => (
        <Tooltip key={entry.person.userId}>
          <TooltipTrigger asChild>
            <span className="relative inline-flex">
              <PersonAvatar
                person={entry.person}
                size="sm"
                // A ring in the surface colour is what separates the overlapping
                // discs; a border would darken every seam.
                className="ring-2 ring-card"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="block font-semibold">
              {entry.person.userId === currentUserId
                ? `${entry.person.name} (${t('sharing.overview.you')})`
                : entry.person.name}
            </span>
            <span className="block text-background/70">{t(`sharing.roles.${entry.role}`)}</span>
          </TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 && (
        <span
          data-testid="participant-overflow"
          // Neutral by design: this bubble is a count, not a person, so it must
          // not borrow anybody's identity colour.
          className="relative inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground ring-2 ring-card"
        >
          {t('thread.participantsMore', { count: overflow })}
        </span>
      )}
    </Fragment>
  )

  const stack = 'flex shrink-0 items-center -space-x-1.5'

  if (!onOpen) {
    return (
      <span
        role="img"
        aria-label={t('thread.participantsAria')}
        data-testid="participant-strip"
        className={cn(stack, className)}
      >
        {faces}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('thread.participantsAria')}
      title={t('sharing.overview.openLabel')}
      data-testid="participant-strip"
      className={cn(
        stack,
        'rounded-full p-0.5 outline-none transition-colors duration-200 ease-out',
        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      {faces}
    </button>
  )
}
