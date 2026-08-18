'use client'

/**
 * Who that is — the panel behind a mention pill.
 *
 * A tag in a thread is a reference to a person, and in a project with forty
 * members a name is often not enough to place them: "@S. Gruber" is either the
 * fire-safety engineer or somebody in accounts. The reader either interrupts
 * themselves to go and look, or guesses. So the reference answers the question
 * where it is asked, on a glance, exactly as a citation does.
 *
 * ONE component for every surface that previews a person, on the same reasoning
 * `CitationPeek` states for citations: two panels describing the same person are
 * two things that can disagree.
 *
 * Deliberately not a profile page in a popover. It carries who they are, how to
 * reach them, and the one fact that matters *in this thread* — whether they can
 * read it. No actions: a mention is a reference, and a panel that appears on
 * hover is the wrong place to put anything consequential.
 */

import { Sparkles } from 'lucide-react'

import { PersonAvatar } from '@/components/ui/avatar-stack'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface PersonPeekPerson {
  userId: string
  name: string
  email?: string | null
  profilePictureUrl?: string | null
}

export interface PersonPeekProps {
  person: PersonPeekPerson
  /** The assistant, which gets its own line rather than an email address. */
  isAgent?: boolean
  /** The reader themselves — worth saying, since "@you" reads oddly otherwise. */
  isYou?: boolean
  /**
   * Whether they can actually read this conversation. `undefined` where the
   * caller does not know — better silent than wrong about someone's access.
   */
  isParticipant?: boolean
  className?: string
}

export function PersonPeek({
  person,
  isAgent = false,
  isYou = false,
  isParticipant,
  className,
}: PersonPeekProps): JSX.Element {
  const t = useTranslations('collaboration')

  return (
    <div data-testid="person-peek" className={cn('flex items-start gap-3', className)}>
      {isAgent ? (
        <span
          aria-hidden
          className="border-border bg-muted text-foreground/80 inline-flex size-9 shrink-0 items-center justify-center rounded-full border"
        >
          <Sparkles className="size-4" />
        </span>
      ) : (
        <PersonAvatar person={person} size="md" />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-semibold">
          {person.name}
          {isYou && (
            <span className="text-muted-foreground font-normal">
              {' '}
              ({t('sharing.overview.you')})
            </span>
          )}
        </p>

        {/* The assistant has no inbox; saying "was asked" about it would be a
            category error. Its second line is what it IS. */}
        {isAgent ? (
          <p className="text-muted-foreground text-xs">{t('mentions.peek.agentRole')}</p>
        ) : (
          person.email && <p className="text-muted-foreground truncate text-xs">{person.email}</p>
        )}

        {/* The thread-relevant fact. Only stated when known, and only for humans:
            "not in this chat yet" is the difference between a tag that reaches
            someone and a tag that quietly does nothing. */}
        {!isAgent && isParticipant !== undefined && (
          <p
            data-testid="person-peek-access"
            className={cn(
              'mt-1.5 text-xs',
              isParticipant ? 'text-muted-foreground' : 'text-warning'
            )}
          >
            {isParticipant
              ? t('mentions.peek.inConversation')
              : t('mentions.peek.notInConversation')}
          </p>
        )}
      </div>
    </div>
  )
}
