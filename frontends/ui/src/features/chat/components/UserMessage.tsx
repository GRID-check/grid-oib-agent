/**
 * UserMessage Component
 *
 * User message bubble displayed in the chat area — the click-dummy "Eingabe"
 * turn: a right-aligned role tab over a bubble with the dummy's asymmetric
 * corner radius, hairline border and trace shadow.
 *
 * ## Two renderings, one component
 *
 * **Without `author` this is byte-for-byte the bubble it has always been.** That
 * is not an accident of refactoring but the requirement: a solo thread must not
 * change at all when sharing ships (spec CC-4, NF-8), so authorship is opt-in and
 * every existing caller keeps today's output.
 *
 * **With `author` the thread has more than one human in it**, and the bubble has to
 * answer "who said this" at a glance. It answers it with the avatar + name header
 * and nothing else.
 *
 * ## Humans do not get messenger left/right
 *
 * **Every human message stays on the RIGHT, in the same card bubble, whoever wrote
 * it** — a colleague's and your own are identical apart from the header. This is
 * the point of the surface, not a styling detail: Piloti is the thing being talked
 * to, and the left/right split is the grammar of a *group chat between people*.
 * Moving a colleague's bubble to the left turns the column into a messenger
 * transcript and quietly demotes the assistant to a participant in it. So the
 * layout stays exactly what a solo thread teaches — humans ask on one side, Piloti
 * answers full-width and dominant — and sharing *adds attribution* rather than
 * re-teaching the reading order.
 *
 * The four voices of spec CC-5 therefore separate on axes that are not "side":
 * a human message is a narrow right-hand bubble (whose header names the human), the
 * agent's answer is a full-width `AgentResponse` card, and its status output is the
 * Herleitung spine. Two different colleagues separate on their headers — different
 * name, different identity-coloured disc — plus the spacing below.
 *
 * **Consecutive messages from one author group** under a single header (the Slack
 * pattern, which is not messenger-specific — it is just not repeating a name three
 * times): the follow-ups drop the header and tuck up under it, which is the single
 * biggest legibility win once three or four messages arrive at once. A speaker
 * *change* gets the opposite treatment — a little more air above it — so the two
 * are told apart by rhythm as well as by the header. Grouped messages stay
 * attributable without eyes via `thread.groupedAria`.
 */

'use client'

import { type FC, useState } from 'react'
import { User, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { SectionLabel } from '@/components/ui/section-label'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { formatTime } from '@/shared/utils/format-time'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { MentionText } from '@/features/collaboration/components/MentionText'
import { MessageAuthor } from './MessageAuthor'

/**
 * The copy control on a bubble, in both renderings.
 *
 * A REVEAL, and reveals need a second way in. `opacity-0 group-hover:opacity-100`
 * is the whole affordance on a mouse, and on a phone there is no hover event to
 * spend: the button was mounted, focusable and permanently invisible, so copying
 * your own message was a feature only desktop had. `pointer-coarse:opacity-100`
 * is the escape the memory panel's row actions already use — where a finger
 * drives the pointer the control is simply present, because there is nothing for
 * it to wait for.
 *
 * Being present is only half of it: at `p-1.5` around a 16px glyph the box is
 * 28px, which is a mouse target sitting in the bubble's top-right corner next to
 * the text you are trying to select. `pointer-coarse:size-11` takes it to the
 * 44px floor (`components/ui/touch-target.spec.ts` holds that line for the
 * primitives; this is one of the bespoke controls it cannot see).
 */
const COPY_BUTTON_CLASS = cn(
  'absolute right-2 top-2 rounded-md bg-muted p-1.5 text-muted-foreground',
  'opacity-0 transition-opacity duration-quick ease-out group-hover:opacity-100',
  'focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none',
  'inline-flex items-center justify-center pointer-coarse:size-11 pointer-coarse:p-0',
  'hover:bg-accent hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
)

/** Who wrote a message, as a shared thread renders it. */
export interface UserMessageAuthor {
  /** WorkOS user id — the seed of the author's identity colour. */
  userId?: string | null
  name?: string | null
  avatarUrl?: string | null
  /** The reader's own message: named "You" instead of by name. */
  isYou?: boolean
}

export interface UserMessageProps {
  content: string
  /** Timestamp of the message (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /**
   * Authorship, present ONLY for a shared conversation (ADR-0033). Omit it — as
   * every pre-collaboration caller does — and the bubble renders exactly as it
   * always has, with no attribution.
   */
  author?: UserMessageAuthor
  /**
   * This message continues a run by the same author: no header, aligned under the
   * one above it. Ignored when `author` is absent.
   */
  grouped?: boolean
  /**
   * Structured mentions carried by this message (spec MN-3), rendered as chips in
   * the text. Never derived from the prose: typing "@Anna" without choosing her
   * from the picker is not a mention and must not look like one.
   */
  mentions?: Array<{ targetId: string; display: string }>
  /** The reader, so a mention OF them can be highlighted differently. */
  currentUserId?: string | null
}

/**
 * User message bubble component
 */
export const UserMessage: FC<UserMessageProps> = ({
  content,
  timestamp,
  author,
  grouped = false,
  mentions,
  currentUserId,
}) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)
  // `formatTime` without a locale falls back to the RUNTIME default, so a
  // German user on an en-US browser read "03:35 PM" here while the HITL prompt
  // directly below it read "15:35". Every research card already passes it.
  const { locale } = useLocale()

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyMessage.failed'))
    }
  }

  /**
   * Message text. A message carrying structured mentions renders through
   * `MentionText`, which turns each one into a chip (and marks a mention of the
   * reader); anything else renders through the same markdown path as before, so
   * the un-mentioned case is unchanged.
   */
  const body =
    mentions && mentions.length > 0 ? (
      <MentionText content={content} mentions={mentions} currentUserId={currentUserId} />
    ) : (
      // `compact`, because the bubble itself is set in `text-sm`: without it
      // the markdown paragraphs came out `text-base`, so the same bubble was
      // 14px or 16px depending on whether the message carried mentions.
      <MarkdownRenderer content={content} compact />
    )

  // ── Solo thread: today's rendering, untouched ───────────────────────────────
  if (!author) {
    return (
      <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col items-end duration-base ease-entrance motion-reduce:animate-none">
        {/* "Eingabe" role tab — uppercase 10.5/600, inset from the bubble edge */}
        <SectionLabel as="div" className="mr-[14px] inline-flex items-center gap-1.5 rounded-t-md bg-accent px-2.5 py-1">
          <User className="size-2.5" aria-hidden="true" />
          {t('roles.input')}
        </SectionLabel>

        {/* Bubble — width 400, asymmetric corners, hairline border, trace shadow */}
        {/* Three corners are the token radius; the 4px top-right is the
            bubble's tail-side notch — the one deliberate value, and what makes
            an input bubble identifiable at a glance. */}
        <div className="group relative w-[400px] max-w-full rounded-lg rounded-tr-[4px] border border-input bg-card px-[14px] py-[11px] text-sm leading-[1.55] text-default shadow-xs pointer-coarse:pr-14">
          {body}
          <button
            type="button"
            onClick={() => void handleCopyMessage()}
            aria-label={copied ? t('copyMessage.copied') : t('copyMessage.copy')}
            className={COPY_BUTTON_CLASS}
          >
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>

        {timestamp && (
          <span className="text-subtle mr-[14px] mt-1 text-xs">{formatTime(timestamp, locale)}</span>
        )}
      </div>
    )
  }

  // ── Shared thread: the same bubble, in the same column, now attributed ──────
  const isYou = author.isYou === true

  return (
    <div
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col items-end duration-base ease-entrance motion-reduce:animate-none',
        // Rhythm carries the run: a grouped follow-up tucks up under its
        // predecessor, a new speaker gets a little more air than the thread's
        // default gap. That contrast is what replaces side-switching.
        grouped ? '-mt-2' : 'mt-1'
      )}
      data-shared-author={author.userId ?? 'unknown'}
    >
      <MessageAuthor
        userId={author.userId}
        name={author.name}
        avatarUrl={author.avatarUrl}
        isYou={isYou}
        timestamp={timestamp}
        grouped={grouped}
        className="mb-1.5"
      />

      <div
        className={cn(
          // Identical for every human, yours and a colleague's alike: the header
          // says who is speaking, the layout says "a person is asking Piloti".
          // Three corners are the token radius; the 4px top-right is the
          // bubble's tail-side notch — the one deliberate value.
          'group relative w-[400px] max-w-full rounded-lg rounded-tr-[4px] border border-input bg-card',
          'px-[14px] py-[11px] text-sm leading-[1.55] text-default shadow-xs',
          // Room for the copy control, which is 44px and ALWAYS VISIBLE on a
          // coarse pointer (see COPY_BUTTON_CLASS). On a mouse it fades in over
          // the text and that is fine — it is only there while the cursor is —
          // but a permanent 44px square in the top-right corner of a bubble sits
          // on the first line of the message and makes it unreadable and
          // unselectable. The padding is the price of the control being present.
          'pointer-coarse:pr-14',
          // A grouped follow-up squares off the corner that pointed at the header
          // it no longer draws, so a run reads as one block of speech. It stays
          // flush with the bubble above — the header sits over the bubble here, not
          // in a left gutter, so indenting would break the column instead of
          // forming it.
          grouped ? 'rounded-tr-lg' : ''
        )}
      >
        {body}
        <button
          type="button"
          onClick={() => void handleCopyMessage()}
          aria-label={copied ? t('copyMessage.copied') : t('copyMessage.copy')}
          className={COPY_BUTTON_CLASS}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* The header carries the time; a grouped follow-up has no header, so it
          keeps the timestamp under the bubble as an unattributed message does. */}
      {grouped && timestamp && (
        <span className="text-subtle mr-[14px] mt-1 text-xs">{formatTime(timestamp, locale)}</span>
      )}
    </div>
  )
}
