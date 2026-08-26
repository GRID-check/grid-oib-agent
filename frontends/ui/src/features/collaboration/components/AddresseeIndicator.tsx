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
 *   1. **It speaks only when it has something to say.** It used to state the default
 *      out loud ("Geht an Piloti") on the theory that a reader should never have to
 *      infer from an absence. That reassurance was paid for on every keystroke of
 *      every thread, and on the empty canvas it was the last piece of furniture left
 *      under the composer. The default is now silent — the two statements below are
 *      what remain, and silence is what makes them legible as changes. The `@` offer
 *      stays exactly where it was: it is the only thing in the product that teaches
 *      mentions exist, and it is not a statement.
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

import { AtSign, Users } from 'lucide-react'

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
  /**
   * Start a mention — the ONLY thing in the product that teaches `@` exists.
   *
   * There was no button, no icon, no tooltip and no onboarding for the feature this
   * whole slice is built around: a user had to already know to type `@`. So the
   * affordance sits on the line that already states the routing, because "this goes
   * to Piloti" is exactly the moment somebody might want it to go to a colleague
   * instead.
   *
   * Offered only in the default `agent` state: while people are already tagged, or
   * while the thread waits on someone, the line has something more important to say
   * and the picker is one keystroke away regardless. Omit to hide (a solo thread has
   * nobody to mention — spec NF-8).
   */
  onMentionSomeone?: () => void
  className?: string
}

/** Which of the three statements this state produces, for tests and screenshots. */
export type AddresseeMode = 'agent' | 'people' | 'thread'

export function AddresseeIndicator({
  mentions,
  awaitingHuman,
  onMentionSomeone,
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

  // The default has nothing to say. It used to say "Geht an Piloti" — the quiet
  // reassurance described above — and on the empty canvas that is a line of
  // furniture under an input box that has no other furniture left. The two
  // statements that survive are the ones a reader cannot derive from anything
  // else on screen: somebody is tagged, or the thread is waiting on a person.
  // Silence in the default case makes those two legible as the changes they are.
  const label =
    mode === 'agent'
      ? null
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
      // Only where there IS a statement. A `status` region labelled with text
      // that is not on screen would announce a promise the sighted reader is
      // not being given; the mention offer below carries its own name.
      role={label ? 'status' : undefined}
      aria-label={label ? t('mentions.addressee.ariaLabel', { label }) : undefined}
      className={cn(
        // `flex-wrap` so the OFFER yields, never the statement. Without it the
        // affordance was `shrink-0` beside a `truncate` label, so a narrow composer
        // rendered "Geht a… · @ Kollegin oder Kollegen erwähnen" — the optional
        // teaching hint at full width and the promise about who receives this
        // message cut in half. That promise is the one thing this element exists to
        // make (ADR-0036 decision 6) and it is not the part that may be abbreviated.
        // Wrapping puts the offer on its own line instead, where it costs nothing.
        'inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground',
        // Placement belongs HERE, not at each call site. In the composer's
        // wrapping chip row this element sat inline when its label was short
        // ("Geht an Piloti") and wrapped when it was long ("Geht an Anna Berger,
        // Tobias Kern"), so it moved between states, the row height jumped, and on
        // a narrow viewport the send button was orphaned on a line of its own. A
        // statement about who receives the message must not change position with
        // the length of a recipient's name. `order-last basis-full` pins it to its
        // own line beneath the row — and owning it here means the dev preview,
        // which builds its own composer facsimile, cannot drift from the real one.
        'order-last basis-full pt-0.5',
        className,
      )}
    >
      {people.length > 0 && <AvatarStack people={people} size="sm" max={3} />}
      {mode === 'thread' && <Users className="size-3.5 shrink-0 opacity-70" aria-hidden />}
      {/* No agent glyph. The spark used to lead the agent — alone, and then at
          the end of a list of people — and the composer no longer carries it
          anywhere: the names say who is addressed, and "Piloti" is one of them. */}
      {label && <span className="min-w-0 truncate">{label}</span>}

      {/* The teaching affordance. A quiet trailing action rather than a button in
          the row above: it must not compete with Send, and it must not look like a
          warning about the statement it follows.

          Underlined AT REST — the same treatment, for the same reason, as the
          engagement notice's control. Both are quiet inline actions sitting in
          running prose at prose weight and prose colour, and an affordance that
          only appears on hover is invisible to the person deciding whether there
          is anything here to press (and never appears at all on touch). Dotted
          keeps it an offer rather than a call to action. */}
      {mode === 'agent' && !agentTagged && onMentionSomeone && (
        <button
          type="button"
          // `…-offer`, not `…-hint`: the composer's own "Piloti antwortet nicht"
          // note already owns `composer-mention-hint`, and while the two never
          // render together (this appears only with nobody tagged, that one only
          // with somebody tagged) a shared id made "no hint is showing" quietly
          // unassertable — a query for one matched the other.
          data-testid="composer-mention-offer"
          onClick={onMentionSomeone}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded px-1 text-xs touch-target',
            'text-muted-foreground/80 transition-colors duration-quick ease-out',
            'underline decoration-dotted decoration-from-font underline-offset-[3px]',
            'hover:text-foreground hover:decoration-solid',
            'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {/* No leading separator. A "·" reads as a divider only while the offer
              sits on the SAME line as the statement; once it wraps to its own line
              the dot leads the line and reads as a stray bullet. The at-rest
              underline and the `@` glyph already mark this as a separate control,
              so the dot was carrying no meaning the reader was missing. */}
          <AtSign className="size-3.5 shrink-0" aria-hidden />
          {t('mentions.addressee.mentionSomeone')}
        </button>
      )}
    </p>
  )
}
