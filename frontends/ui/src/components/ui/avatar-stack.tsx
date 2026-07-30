'use client'

/**
 * AvatarStack — a group of people as overlapping discs, with the tail collapsed
 * into a `+N` bubble.
 *
 * Any "these people are involved" surface needs this shape: a conversation's
 * participants, the colleagues a thread is waiting on, the members of a project.
 * It lives here (and is built from {@link Avatar}) rather than in a feature
 * because two surfaces had already hand-rolled it and were drifting on the disc
 * size, the overlap and the ring.
 *
 * Three properties are load-bearing:
 *
 *   1. **It does not sort.** Order is the caller's information — "owners first",
 *      "oldest request first" — and a primitive that re-sorts would silently
 *      overrule it. It renders `people` exactly as given.
 *   2. **It is not interactive.** No click target, no tab stop. A caller that
 *      wants the stack to open something wraps it in one button (one control, not
 *      one per face — a button per disc inside a button is invalid HTML and a
 *      keyboard minefield), and a caller that wants per-face tooltips supplies
 *      `renderPerson`.
 *   3. **The discs are big enough for two initials.** See {@link AVATAR_STACK_SIZES}:
 *      the overlap plus the ring eats the trailing edge of every disc, and at 24px
 *      that clipped the second initial ("MB" rendered as "MI"). 28px is the
 *      measured floor, so `sm` is 28 and not 24.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { avatarColorStyle, avatarHue, personInitials } from './avatar-identity'

/**
 * The minimum a person must be to be drawn: an id (which the identity colour is
 * derived from) and a name (which the initials come from). Structurally satisfied
 * by `DirectoryPerson` and by anything else with those fields, so no feature type
 * has to be imported here.
 */
export interface AvatarStackPerson {
  userId: string
  name: string
  profilePictureUrl?: string | null
}

/**
 * Disc sizes. `sm` is 28px rather than 24px for one measured reason: in the
 * overlapping stack each disc loses its trailing ~6px (negative margin) plus the
 * next disc's 2px ring, and at 24px that ate the second initial — "MB" rendered
 * as "MI". 28px keeps two centred initials clear of the seam.
 */
export const AVATAR_STACK_SIZES = {
  sm: 'size-7 text-[10px]',
  md: 'size-8 text-xs',
} as const

export type AvatarStackSize = keyof typeof AVATAR_STACK_SIZES

/** Faces drawn before the rest collapse into a `+N` bubble. */
const DEFAULT_MAX = 4

export interface PersonAvatarProps {
  person: AvatarStackPerson
  size?: AvatarStackSize
  className?: string
}

/**
 * One person's avatar: their photo when we have one, otherwise their initials on
 * the colour their user id always maps to (`./avatar-identity`). Exported on its
 * own because roster rows and list items need a single disc, and it must be the
 * same disc the stack draws.
 */
export function PersonAvatar({ person, size = 'md', className }: PersonAvatarProps): JSX.Element {
  return (
    <Avatar
      className={cn(AVATAR_STACK_SIZES[size], className)}
      data-testid="person-avatar"
      // The identity hue, surfaced as data: the colour itself is a `color-mix()`
      // that only a real browser resolves, so this is what a test (or a person
      // debugging "why are these two discs the same?") can actually read.
      data-avatar-hue={avatarHue(person.userId)}
    >
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

export interface AvatarStackProps {
  /** The people, **in the order they should be drawn**. Never re-sorted here. */
  people: readonly AvatarStackPerson[]
  /** Faces before the `+N` bubble. Defaults to 4; at least 1. */
  max?: number
  size?: AvatarStackSize
  /**
   * Wrap each face — the seam for per-person tooltips. Receives the person, the
   * rendered disc, and the person's index in `people` (so a caller can reach the
   * richer row the person came from), and returns whatever should stand in the
   * disc's place. Keys are the stack's business, so the returned node needs none.
   */
  renderPerson?: (
    person: AvatarStackPerson,
    face: React.ReactNode,
    index: number
  ) => React.ReactNode
  className?: string
}

export function AvatarStack({
  people,
  max = DEFAULT_MAX,
  size = 'md',
  renderPerson,
  className,
}: AvatarStackProps): JSX.Element | null {
  if (people.length === 0) return null

  const visible = people.slice(0, Math.max(1, max))
  const overflow = people.length - visible.length

  return (
    <span
      data-slot="avatar-stack"
      className={cn('inline-flex shrink-0 items-center -space-x-1', className)}
    >
      {visible.map((person, index) => {
        const face = (
          <PersonAvatar
            person={person}
            size={size}
            // A ring in the surface colour is what separates the overlapping
            // discs; a border would darken every seam.
            className="ring-2 ring-card"
          />
        )
        return (
          // Index-suffixed: the same person can legitimately appear twice (two
          // outstanding requests to one colleague), and a duplicate key there
          // would drop a face.
          <React.Fragment key={`${person.userId}-${index}`}>
            {renderPerson ? renderPerson(person, face, index) : face}
          </React.Fragment>
        )
      })}
      {overflow > 0 && (
        <span
          data-slot="avatar-stack-overflow"
          data-testid="avatar-stack-overflow"
          // Neutral by design: this bubble is a count, not a person, so it must
          // not borrow anybody's identity colour.
          className={cn(
            'relative inline-flex items-center justify-center rounded-full bg-muted font-semibold tabular-nums text-muted-foreground ring-2 ring-card',
            AVATAR_STACK_SIZES[size]
          )}
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}
