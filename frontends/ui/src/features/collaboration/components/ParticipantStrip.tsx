'use client'

/**
 * The at-a-glance overview: who is in this conversation, as an overlapping avatar
 * stack that opens the full access panel.
 *
 * The stack itself is `AvatarStack` (`@/components/ui/avatar-stack`) — the discs,
 * the overlap, the ring and the `+N` bubble are a UI primitive, not a
 * collaboration detail. What is left here is the part that is genuinely about a
 * conversation's roster:
 *
 *   1. **Solo threads render nothing.** A single-participant private chat is the
 *      overwhelmingly common case, and a "1 person" stack there is collaboration
 *      furniture charging rent on a surface where nothing is being collaborated on.
 *      No strip is the correct answer, not an empty one.
 *   2. **Owners first, then the role ladder, then name.** The order must not depend
 *      on when someone was invited or where the server happened to put them, or the
 *      faces move under the reader between renders and stop being recognisable. The
 *      primitive never re-sorts, so this ordering is the one the reader sees.
 *   3. **One button, not N buttons.** The whole strip is a single control that opens
 *      the overview; the per-avatar tooltips hang off plain `<span>`s inside it.
 *      Nesting a button per face inside a button is invalid HTML and would make the
 *      strip a tab-stop minefield — the names are reachable for keyboard and screen
 *      reader users in the panel the button opens, which is also where they are
 *      actionable.
 */

import { AvatarStack } from '@/components/ui/avatar-stack'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import type { ResourceAccessEntry, ResourceRole } from '@/lib/sharing/types'
import { cn } from '@/lib/utils'

/** Strongest first — the order the strip and the overview both sort by. */
const ROLE_RANK: Record<ResourceRole, number> = { owner: 0, collaborator: 1, viewer: 2 }

/** Faces shown before the rest collapse into a `+N` bubble. */
const DEFAULT_MAX_VISIBLE = 4

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

  const stack = (
    <AvatarStack
      people={ordered.map((entry) => entry.person)}
      max={maxVisible}
      size="sm"
      // The name and what they may do, on hover — hung off a plain span so the
      // strip stays ONE control (note 3). The index is the roster row the face
      // came from, which is where the role lives.
      renderPerson={(person, face, index) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="relative inline-flex">{face}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="block font-semibold">
              {person.userId === currentUserId
                ? `${person.name} (${t('sharing.overview.you')})`
                : person.name}
            </span>
            <span className="block text-background/70">
              {t(`sharing.roles.${ordered[index].role}`)}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    />
  )

  if (!onOpen) {
    return (
      <span
        role="img"
        aria-label={t('thread.participantsAria')}
        data-testid="participant-strip"
        className={cn('inline-flex shrink-0 items-center', className)}
      >
        {stack}
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
        'inline-flex shrink-0 items-center rounded-full p-0.5 outline-none',
        'transition-colors duration-200 ease-out',
        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      {stack}
    </button>
  )
}
