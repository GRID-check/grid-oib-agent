'use client'

/**
 * Renders message text with its mentions as chips.
 *
 * Three properties matter here:
 *
 * 1. **XSS-safe by construction.** The text is split into segments and each one
 *    becomes a React node. There is no `dangerouslySetInnerHTML` anywhere on this
 *    path, and there must never be: this is user-authored text from another person
 *    in the thread.
 *
 * 2. **Only the message's OWN mentions become chips** (spec MN-3). The segments come
 *    from the structured `{ targetId, display }` list the server stored with the
 *    message, so text that merely looks like `@Someone` stays plain text — the same
 *    rule that decides who was notified decides what lights up.
 *
 * 3. **A mention of YOU is louder.** Being tagged is the one thing in a thread that
 *    asks something of the reader, so it is rendered as a filled chip with its own
 *    aria label, while a mention of somebody else stays a quiet reference.
 */

import { Fragment } from 'react'

import { useTranslations } from '@/i18n'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'
import { splitMentionSegments, type DraftMention } from '../lib/mention-text'

export interface MentionTextProps {
  content: string
  /** The message's structured mentions. Without them nothing is chipped. */
  mentions?: readonly DraftMention[]
  /** The reader, so a mention OF them can be emphasised. */
  currentUserId?: string | null
  className?: string
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
        const isAgent = segment.targetId === AGENT_MENTION_ID

        return (
          <span
            key={index}
            data-testid="mention-chip"
            data-mention-target={segment.targetId}
            data-mention-me={isMe ? 'true' : 'false'}
            // A tag of the reader is filled ink — it is the one that asks something
            // of them. Everyone else's is a quiet tint, so a thread full of
            // mentions stays readable.
            className={cn(
              'mx-px inline-flex items-baseline rounded-md px-1 py-px align-baseline text-[0.9375em] font-medium',
              isMe
                ? 'bg-primary text-primary-foreground'
                : isAgent
                  ? 'bg-foreground/[0.08] text-foreground/85'
                  : 'bg-muted text-foreground/80',
            )}
            aria-label={
              isMe
                ? t('thread.mentionedYouAria')
                : t('thread.mentionAria', { name: segment.display })
            }
          >
            {segment.text}
          </span>
        )
      })}
    </span>
  )
}
