/**
 * MessageAuthor — who wrote a message, in a shared thread (spec CC-4).
 *
 * A solo thread renders no attribution at all and must keep looking exactly as it
 * does today, so this header only ever appears once a conversation is shared. It
 * is the smallest piece of the multi-author story and the one everything else
 * leans on: an avatar the reader recognises plus a name they can scan.
 *
 * It is also the ONLY thing that differentiates one human from another in a shared
 * thread: every human bubble sits on the same side in the same card (see
 * `UserMessage`), because left/right is group-chat grammar and Piloti — not the
 * people — is the centre of this surface. So this header carries the whole "who
 * said this" job, which is why the disc and the name are both always present.
 *
 * Four deliberate choices:
 *
 *   - **The avatar is never blank.** With a real `authorAvatarUrl` it is the photo;
 *     without one it is the person's initials on their deterministic identity
 *     colour (`@/components/ui/avatar-identity`), which is keyed on the USER ID, so
 *     the same colleague is the same colour in the thread, the roster and the
 *     mention picker — and does not change when somebody new is invited.
 *   - **Colour is a recognition aid, never the information.** The disc always
 *     carries initials or a photo as well, so nothing is conveyed by hue alone.
 *   - **The name is not read twice.** The whole header is one labelled group
 *     (`thread.authorAria`, or `thread.groupedAria` for a continuation), and the
 *     visible text is hidden from the accessibility tree, so a screen reader hears
 *     "Message from Anna Berger" once instead of the name plus a stray avatar.
 *   - **It always sits over the right-hand bubble**, reversed and inset to line up
 *     with it. There is no `align` choice to make: the bubble never moves.
 */

'use client'

import { type FC } from 'react'
import Image from 'next/image'
import { avatarColorStyle, personInitials } from '@/components/ui/avatar-identity'
import { formatTime } from '@/shared/utils/format-time'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface MessageAuthorProps {
  /**
   * WorkOS user id of the author — the seed of the identity colour. Absent for a
   * legacy message the server could not attribute, which still renders (with the
   * neutral disc) rather than losing its header.
   */
  userId?: string | null
  /** Resolved display name. Falls back to "You" for the reader's own messages. */
  name?: string | null
  avatarUrl?: string | null
  /** True when this is the reader's own message: the name becomes "You". */
  isYou?: boolean
  timestamp?: Date | string
  /**
   * A continuation of the previous message by the same author: the header is not
   * drawn, and the row exists only to announce the continuation to a screen
   * reader (spec `thread.groupedAria`).
   */
  grouped?: boolean
  className?: string
}

/** Disc size, matched to the bubble's type scale rather than the shell's avatars. */
const AVATAR_CLASS =
  'flex size-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full text-[9.5px] font-semibold uppercase leading-none'

export const MessageAuthor: FC<MessageAuthorProps> = ({
  userId,
  name,
  avatarUrl,
  isYou = false,
  timestamp,
  grouped = false,
  className,
}) => {
  const t = useTranslations('collaboration')

  const displayName = isYou ? t('thread.authorYou') : (name?.trim() || t('inbox.unknownActor'))
  const label = grouped
    ? t('thread.groupedAria', { name: displayName })
    : t('thread.authorAria', { name: displayName })

  // A grouped message carries no visible header — that IS the grouping — but it
  // still has to be attributable without eyes, so the label rides on a
  // screen-reader-only element instead of an empty row of chrome.
  if (grouped) {
    return <span className="sr-only">{label}</span>
  }

  return (
    <div
      // Reversed and inset to match the bubble it sits over: every human message
      // is right-aligned, whoever wrote it, so this header always is too.
      className={cn('flex flex-row-reverse items-center gap-2 pr-[14px]', className)}
      // One accessible name for the whole header, so the avatar and the visible
      // name are not announced separately.
      role="group"
      aria-label={label}
      data-testid="message-author"
    >
      {avatarUrl ? (
        // The disc is a fixed 22px, so the size is declared rather than filled:
        // the box is reserved before the photo arrives, and the image lazy-loads
        // and decodes off the main thread the way next/image does everywhere.
        // `unoptimized` is load-bearing — directory avatars come from whichever
        // host the customer's IdP serves them from, and the optimizer only
        // fetches hosts named in `images.remotePatterns`, so routing them
        // through it would fail on every host we did not predict. Drop the prop
        // the day those hosts are pinned; nothing else here has to change.
        <Image
          src={avatarUrl}
          alt=""
          width={22}
          height={22}
          unoptimized
          aria-hidden="true"
          className={cn(AVATAR_CLASS, 'object-cover')}
          data-testid="message-author-avatar"
        />
      ) : (
        <span
          className={AVATAR_CLASS}
          // Identity colour from the user id; a message with no author falls back
          // to the neutral disc rather than pretending to identify somebody.
          style={userId ? avatarColorStyle(userId) : undefined}
          aria-hidden="true"
          data-testid="message-author-initials"
        >
          {/* Initials come from the real name even for your own messages, whose
              label is "You" — "Y" on every one of your discs reads as a bug. */}
          {name?.trim() ? personInitials(name) : userId ? personInitials(displayName) : '?'}
        </span>
      )}

      <span className="flex items-baseline gap-1.5" aria-hidden="true">
        <span className="text-[12.5px] font-semibold leading-none text-foreground">
          {displayName}
        </span>
        {timestamp && (
          <span className="text-subtle text-[11px] leading-none tabular-nums">
            {formatTime(timestamp)}
          </span>
        )}
      </span>
    </div>
  )
}
