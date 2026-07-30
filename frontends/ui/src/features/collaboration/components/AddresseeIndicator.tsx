'use client'

/**
 * "Who does this message go to?", said out loud in the composer (ADR-0034 addendum).
 *
 * The behaviour it describes is correct server-side and was *invisible*: after a
 * colleague answers, nothing on screen told you whether your next plain message
 * was a question for Piloti or a remark to the people in the thread. The reviewer's
 * words were "I don't think it is clear out of the UI" — and a rule the user has to
 * infer is still an unclear product.
 *
 * Three properties are load-bearing:
 *
 *   1. **It is always present.** If it only appeared in the unusual case, "Piloti is
 *      next" would stay an inference — the reader would have to notice an *absence*
 *      to conclude anything. The default rendering ("Geht an Piloti") is the quiet
 *      reassurance that makes the other two legible as changes.
 *   2. **It states, it does not warn.** No border, no fill, no chroma: it sits in the
 *      action row between real buttons and must never look like one of them, nor
 *      like an error. Ink and paper, one line.
 *   3. **It is honest about every combination**, including the awkward one: tagging a
 *      person *and* `@Piloti` addresses both (MN-1), so both are named — and the
 *      "Piloti stays quiet" hint is then suppressed by the caller, because it would
 *      be false.
 *
 * A `status` region, so the transition — the thing that actually teaches the model —
 * is announced rather than only drawn.
 */

import { Sparkles, Users } from 'lucide-react'

import { AvatarStack, type AvatarStackPerson } from '@/components/ui/avatar-stack'
import { useTranslations } from '@/i18n'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'
import type { DraftMention } from '../lib/mention-text'

export interface AddresseeIndicatorProps {
  /**
   * The mentions that survive the text being composed, in text order — exactly
   * what the composer would send. Reconciled by the caller, so deleting an
   * `@Anna` token changes this line as the character disappears.
   */
  mentions: readonly DraftMention[]
  /**
   * Whether the thread is currently waiting on a named person, as derived by the
   * server (`useAwaitingState`). Never computed locally: the banner, the inbox and
   * this line all read the same rows so they cannot disagree (ADR-0034).
   */
  awaitingHuman: boolean
  className?: string
}

/** Which of the three statements this state produces, for tests and screenshots. */
export type AddresseeMode = 'agent' | 'people' | 'thread'

export function AddresseeIndicator({
  mentions,
  awaitingHuman,
  className,
}: AddresseeIndicatorProps): JSX.Element {
  const t = useTranslations('collaboration')

  const humans = mentions.filter((mention) => mention.targetId !== AGENT_MENTION_ID)
  const agentTagged = mentions.some((mention) => mention.targetId === AGENT_MENTION_ID)
  const agentName = t('mentions.picker.agentName')

  // Tagging beats the thread state: the message being written decides where it
  // goes, and `@Piloti` is the documented way back out of a wait (MN-9.3).
  const mode: AddresseeMode =
    humans.length > 0 ? 'people' : agentTagged || !awaitingHuman ? 'agent' : 'thread'

  // The agent rides along at the END of the list: the humans were tagged first and
  // are who the question is for; Piloti answering too is the addition.
  const names = [...humans.map((mention) => mention.display), ...(agentTagged ? [agentName] : [])]

  const label =
    mode === 'agent'
      ? t('mentions.addressee.toAgent')
      : mode === 'thread'
        ? t('mentions.addressee.toThread')
        : names.length === 1
          ? t('mentions.addressee.toPerson', { name: names[0] })
          : t('mentions.addressee.toPeople', { names: names.join(', ') })

  /*
    Human mentions carry the user id as their target, which is exactly what the
    identity colour is keyed on — so a colleague's disc here is the same disc as in
    the participant strip, the roster and their message bubbles.
  */
  const people: AvatarStackPerson[] = humans.map((mention) => ({
    userId: mention.targetId,
    name: mention.display,
  }))

  return (
    <p
      data-testid="composer-addressee"
      data-mode={mode}
      role="status"
      aria-label={t('mentions.addressee.ariaLabel', { label })}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground',
        className,
      )}
    >
      {people.length > 0 && <AvatarStack people={people} size="sm" max={3} />}
      {mode === 'thread' && <Users className="size-3.5 shrink-0 opacity-70" aria-hidden />}
      {(mode === 'agent' || agentTagged) && (
        <Sparkles className="size-3.5 shrink-0 opacity-70" aria-hidden />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </p>
  )
}
