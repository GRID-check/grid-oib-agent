'use client'

/**
 * "Anna is writing…" — a colleague at a keyboard.
 *
 * Deliberately **not** the vocabulary the agent gets. A turn in flight uses the
 * Piloti glyph and the shimmering label (`TurnInFlightBanner`); a person uses
 * their avatar and three bouncing dots, the shape every messenger has taught
 * everybody to read. Keeping the two apart is what stops the thread from framing
 * Piloti as one more participant in a group chat, and it means the reader can tell
 * at a glance whether the pause is a machine working or a colleague thinking.
 *
 * Renders nothing for an empty list, so a caller can mount it unconditionally.
 *
 * The announcement is `polite` and carries only the names, not "is typing": a
 * screen-reader user who hears somebody named every three seconds learns nothing
 * and loses the thread they were reading. The visible dots carry the verb.
 */

import type { FC } from 'react'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { useTranslations } from '@/i18n'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { cn } from '@/lib/utils'

export interface TypingPresenceProps {
  /** Colleagues currently composing. Never the reader themselves. */
  typists: DirectoryPerson[]
  className?: string
}

/** Beyond this many names the line stops being readable and starts being a list. */
const MAX_NAMED = 2

export const TypingPresence: FC<TypingPresenceProps> = ({ typists, className }) => {
  const t = useTranslations('collaboration')
  if (typists.length === 0) return null

  const named = typists.slice(0, MAX_NAMED)
  const overflow = typists.length - named.length
  const names = named.map((person) => person.name).join(t('thread.typingNameSeparator'))
  const label =
    overflow > 0
      ? t('thread.typingMany', { names, count: overflow })
      : t('thread.typing', { names })

  return (
    <div
      className={cn('flex w-fit items-center gap-2 py-1', className)}
      data-testid="typing-presence"
    >
      <div className="flex -space-x-1.5">
        {named.map((person) => (
          <PersonAvatar key={person.userId} person={person} size="sm" />
        ))}
      </div>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="bg-muted-foreground/60 size-1 animate-bounce rounded-full"
            // Staggered so the three dots read as a wave rather than a pulse.
            style={{ animationDelay: `${index * 150}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
    </div>
  )
}
