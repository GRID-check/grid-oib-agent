'use client'

/**
 * The hand-BACK offer: the way on, at the moment the thread is worth handing on.
 *
 * `AwaitingBanner` carries "Stattdessen Piloti fragen", and it returns `null` the
 * instant the wait resolves — so at the exact moment the thread holds its most
 * valuable context (the colleague has just answered) there was **no affordance at
 * all**, and the user had to already know that typing `@Piloti` is what continues.
 * That was the gap: the state machine's last transition — *waiting → they answer →
 * asking Piloti* — was the one nothing on screen offered.
 *
 * Three decisions, each of which a "nicer" version would get wrong:
 *
 *   1. **It pre-fills the composer; it does not fire a turn.** A button that sent a
 *      turn would either put a message under the user's name that they did not
 *      write, or produce an agent answer with no visible question — in a thread
 *      several people read as a shared record. It would also ask the agent nothing,
 *      which yields "Based on the discussion above…" mush. Pre-filling is still one
 *      keypress, and discoverability was the actual problem.
 *   2. **It is transient, not furniture.** It disappears once the user sends or
 *      dismisses it. A permanent header button would imply a thread can be
 *      "resolved" (it is not a ticket) and would leave an always-live,
 *      token-spending control one stray click away.
 *   3. **It is quiet.** Ink and paper at the house radius, the Piloti mark rather
 *      than a colour: this is an offer, not an alert, and the agent's answer must
 *      stay the loudest thing in the column.
 */

import type { JSX } from 'react'
import { X } from 'lucide-react'

import { AvatarStack, type AvatarStackPerson } from '@/components/ui/avatar-stack'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface HandbackOfferProps {
  /**
   * The people whose answers ended the wait, in the order they spoke. Empty
   * renders nothing — there is nobody to name, so there is no honest offer.
   */
  people: readonly AvatarStackPerson[]
  /** Pre-fill the composer with `@Piloti …` and focus it. Never sends. */
  onAccept: () => void
  onDismiss: () => void
  className?: string
}

export function HandbackOffer({
  people,
  onAccept,
  onDismiss,
  className,
}: HandbackOfferProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  if (people.length === 0) return null

  const names = people.map((person) => person.name)
  const offer =
    names.length === 1
      ? t('mentions.handback.offer', { name: names[0] })
      : t('mentions.handback.offerMany', { names: names.join(', ') })

  return (
    <div
      data-testid="handback-offer"
      // Appears dynamically under the colleague's answer — announced politely,
      // like the awaiting banner's own live region.
      role="status"
      className={cn(
        'flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3.5 py-2 shadow-xs',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AvatarStack people={people} size="sm" max={3} />
        <span className="min-w-0 text-xs text-foreground">{offer}</span>
      </span>

      <span className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onAccept}>
          {t('mentions.handback.action')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={t('mentions.handback.dismiss')}
          title={t('mentions.handback.dismiss')}
          onClick={onDismiss}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </span>
    </div>
  )
}
