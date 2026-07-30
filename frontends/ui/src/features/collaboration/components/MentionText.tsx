'use client'

/**
 * Renders message text with its mentions as pills.
 *
 * Four properties matter here:
 *
 * 1. **XSS-safe by construction.** The text is split into segments and each one
 *    becomes a React node. There is no `dangerouslySetInnerHTML` anywhere on this
 *    path, and there must never be: this is user-authored text from another person
 *    in the thread.
 *
 * 2. **Only the message's OWN mentions become pills** (spec MN-3). The segments come
 *    from the structured `{ targetId, display }` list the server stored with the
 *    message, so text that merely looks like `@Someone` stays plain text — the same
 *    rule that decides who was notified decides what lights up.
 *
 * 3. **A mention of YOU is louder.** Being tagged is the one thing in a thread that
 *    asks something of the reader, so it is rendered as a filled pill with its own
 *    aria label, while a mention of somebody else stays a quiet reference.
 *
 * 4. **A pill answers "who is that?" on a glance** — the same peek behaviour as a
 *    citation, sharing the same `useHoverPopover` timing, because a reference the
 *    reader has to leave the thread to resolve is a reference that gets guessed at.
 *    Interactive ONLY when the person resolves (see `context/mention-people`): with
 *    nothing to show, a button that opens an empty panel is worse than a span.
 */

import { Fragment } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useTranslations } from '@/i18n'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { motion, springSnappy } from '@/components/motion'
import { cn } from '@/lib/utils'
import { useMentionPerson } from '../context/mention-people'
import { splitMentionSegments, type DraftMention } from '../lib/mention-text'
import { PersonPeek } from './PersonPeek'

export interface MentionTextProps {
  content: string
  /** The message's structured mentions. Without them nothing is pilled. */
  mentions?: readonly DraftMention[]
  /** The reader, so a mention OF them can be emphasised. */
  currentUserId?: string | null
  className?: string
}

/**
 * The pill's look, shared by the plain and the interactive variants so they cannot
 * drift into two different-looking mentions in one thread.
 */
const pillClasses = (isMe: boolean, isAgent: boolean, interactive: boolean): string =>
  cn(
    // Padding kept to 3px and NO horizontal margin, because a mention sits inside
    // running prose: at `px-1 mx-px` the pill pushed the following character away
    // and "@Matthias Bigl, das passt" rendered as "@Matthias Bigl , das passt" —
    // a stray space before a comma. Some gap is unavoidable (every product with
    // inline mention pills has it); this is the tightest that still reads as a
    // pill rather than a highlight.
    'inline-flex items-baseline rounded-md px-[3px] py-px align-baseline text-[0.9375em] font-medium',
    // A mention of YOU is the only signal that a message wants something from the
    // reader — no row treatment carries it — so it has to survive a scan. It does
    // NOT have to win the page. At `bg-primary` it was a solid ink block in light
    // and a solid white one in dark: the highest-contrast element on screen,
    // louder than the sentence it annotates and reading as a redaction rather than
    // a person. The tint/text pair is the one the `warning` Chip and Badge already
    // use for "this concerns you" (the picker's "Wird eingeladen", the peek card's
    // "Nicht in diesem Chat"), so this borrows an established meaning instead of
    // minting a louder one.
    isMe
      ? 'bg-warning-subtle text-warning'
      : isAgent
        ? 'bg-foreground/[0.08] text-foreground/85'
        : 'bg-muted text-foreground/80',
    interactive &&
      cn(
        'cursor-pointer transition-[filter,box-shadow] hover:brightness-95 dark:hover:brightness-125',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )
  )

/** One mention that resolved to a person: a pill you can look at. */
function MentionPill({
  targetId,
  text,
  label,
  isMe,
}: {
  targetId: string
  text: string
  label: string
  isMe: boolean
}): JSX.Element {
  const peek = useHoverPopover()
  const resolved = useMentionPerson(targetId)
  const isAgent = targetId === AGENT_MENTION_ID

  // No provider, or a person who cannot be placed: a plain reference, exactly as
  // before. Never a button that opens nothing.
  if (!resolved) {
    return (
      <span
        data-testid="mention-chip"
        data-mention-target={targetId}
        data-mention-me={isMe ? 'true' : 'false'}
        className={pillClasses(isMe, isAgent, false)}
        aria-label={label}
      >
        {text}
      </span>
    )
  }

  return (
    <Popover open={peek.open} onOpenChange={peek.onOpenChange}>
      <PopoverAnchor asChild>
        {/* A press gives way slightly — `springSnappy` is the kit's vocabulary for
            anything the user physically touches, and it is the only motion a pill
            gets. Nothing on mount: these render inline in prose, and a message
            whose mentions animate in draws the eye away from the sentence. Scale
            only, no vertical move, so a pill cannot nudge the line it sits on. */}
        <motion.button
          type="button"
          data-testid="mention-chip"
          data-mention-target={targetId}
          data-mention-me={isMe ? 'true' : 'false'}
          data-mention-interactive="true"
          whileTap={{ scale: 0.96 }}
          transition={springSnappy}
          {...peek.triggerProps}
          className={pillClasses(isMe, resolved.isAgent, true)}
          aria-label={label}
        >
          {text}
        </motion.button>
      </PopoverAnchor>
      {/* Narrower than the citation peek: a person is four short lines, and a
          panel sized for a source snippet would be mostly empty. */}
      <PopoverContent align="start" className="w-64 p-3" {...peek.contentProps}>
        <PersonPeek
          person={resolved.person}
          isAgent={resolved.isAgent}
          isYou={resolved.isYou}
          isParticipant={resolved.isParticipant}
        />
      </PopoverContent>
    </Popover>
  )
}

export function MentionText({
  content,
  mentions,
  currentUserId,
  className,
}: MentionTextProps): JSX.Element {
  const t = useTranslations('collaboration')
  const segments = splitMentionSegments(content, mentions ?? [])

  return (
    <span className={cn('whitespace-pre-wrap', className)} data-testid="mention-text">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>

        const isMe = Boolean(currentUserId) && segment.targetId === currentUserId

        return (
          <MentionPill
            key={index}
            targetId={segment.targetId}
            text={segment.text}
            isMe={isMe}
            label={
              isMe
                ? t('thread.mentionedYouAria')
                : t('thread.mentionAria', { name: segment.display })
            }
          />
        )
      })}
    </span>
  )
}
