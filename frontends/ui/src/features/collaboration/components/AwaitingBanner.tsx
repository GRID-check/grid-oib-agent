'use client'

/**
 * The hand-off banner (spec MN-8, MN-9, MN-10).
 *
 * This component exists for one reason: **the agent's silence must never be
 * unexplained.** When a message tags a person, no turn is started at all (MN-7) —
 * which, without something on screen saying so, is indistinguishable from a broken
 * product. So the banner names who is awaited, says out loud that Piloti is holding
 * off, and — crucially — always offers a way out: any participant may release the
 * wait, and anyone may hand the question to the agent instead. A thread must never
 * be stuck because one person went on holiday.
 *
 * Two states, one component:
 *   - **someone else is awaited** — calm, informational; ink and paper.
 *   - **YOU are awaited** (`awaitingMe`) — the one moment this surface asks for
 *     something, so it carries the "needs attention" gold of the house language
 *     (icon + label + colour, never colour alone) and stronger copy.
 *
 * It renders the derived server state verbatim (`useAwaitingState`) and never
 * computes a wait locally: the banner, the participants' banners and the
 * recipient's inbox all read the same rows, so they cannot disagree (ADR-0034).
 */

import { useState } from 'react'
import type { JSX } from 'react'
import { Clock, CornerUpLeft, Hand } from 'lucide-react'

import { AvatarStack, PersonAvatar } from '@/components/ui/avatar-stack'
import { AnimatePresence, motion, springGentle } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import type { AwaitingStateResponse, PendingMentionView } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'

export interface AwaitingBannerProps {
  /** The derived hand-off state; `null` or empty `pending` renders nothing. */
  awaiting: AwaitingStateResponse | null
  /** Release one outstanding request. Resolves false when the server refused. */
  onRelease: (requestId: string) => Promise<boolean> | boolean
  /** Hand the question to the assistant instead (MN-9.3). Omit to hide. */
  onAskAgent?: () => void
  /**
   * Put a question BACK to whoever asked — offered only to the person who was
   * asked, and only when there is a single named asker to send it to.
   *
   * The affordance exists because the obvious move (type a plain reply) is the
   * one that misfires: a plain contribution settles the request, so a clarifying
   * question reads as an answer, ends the wait and hands the thread back to the
   * agent mid-conversation. Routing it as a mention keeps the thread waiting on
   * the person who can actually answer.
   */
  onAskBack?: (asker: { userId: string; name: string }) => void
  className?: string
}

export function AwaitingBanner({
  awaiting,
  onRelease,
  onAskAgent,
  onAskBack,
  className,
}: AwaitingBannerProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  const { locale } = useLocale()
  const [releasing, setReleasing] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const pending = awaiting?.pending ?? []
  if (pending.length === 0) return null

  const awaitingMe = awaiting?.awaitingMe === true
  const names = pending.map((request) => request.person.name)
  const single = pending.length === 1 ? pending[0] : null
  const oldest = pending.reduce(
    (earliest, request) => (request.createdAt < earliest.createdAt ? request : earliest),
    pending[0],
  )
  /** Names carried by more than one row — see the per-row release button. */
  const repeatedNames = new Set(
    names.filter((name, index) => names.indexOf(name) !== index),
  )

  const headline = awaitingMe
    ? t('mentions.awaiting.awaitingYou')
    : single
      ? t('mentions.awaiting.one', { name: single.person.name })
      : t('mentions.awaiting.many', { names: names.join(', ') })

  const hint = awaitingMe
    ? t('mentions.awaiting.awaitingYouHint')
    : t('mentions.awaiting.hint')

  /**
   * Release one request, or all of them (the thread-level action). Sequential on
   * purpose: each release is a write the server answers with the new derived
   * state, and firing them in parallel would race those answers.
   */
  const release = async (requests: readonly PendingMentionView[], key: string): Promise<void> => {
    setReleasing(key)
    setFailed(false)
    try {
      let ok = true
      for (const request of requests) {
        ok = (await onRelease(request.id)) !== false && ok
      }
      // A failed release must say so: silently leaving the banner up would read
      // as "the button does nothing".
      if (!ok) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setReleasing(null)
    }
  }

  return (
    <section
      data-testid="awaiting-banner"
      data-awaiting-me={awaitingMe ? 'true' : 'false'}
      aria-live="polite"
      className={cn(
        'rounded-lg border px-4 py-3 shadow-xs',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance',
        // `border-warning` / `bg-warning-*` are static `@utility` blocks in
        // globals.css with no `--modifier()`, so a slash-opacity form
        // (`border-warning/40`) matches nothing and silently fell back to the
        // neutral border. Use the tokens as defined.
        awaitingMe ? 'border-warning bg-warning-subtle' : 'bg-card',
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full border',
            // Same reason as the section border: `bg-warning/15` compiled to
            // nothing, so this disc had no fill at all. A bordered disc on the
            // card surface reads against the subtle warning background, which
            // a second `bg-warning-subtle` would not.
            awaitingMe
              ? 'border-warning bg-card text-warning'
              : 'border-border bg-muted text-muted-foreground',
          )}
        >
          {awaitingMe ? <Hand className="size-4" /> : <Clock className="size-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Who is holding the thread, at a glance — the shared avatar stack, so
                a colleague looks the same here as in the participant strip and in
                their message bubbles. */}
            <AvatarStack people={pending.map((request) => request.person)} size="sm" />
            <p
              className={cn(
                'min-w-0 text-sm font-semibold',
                awaitingMe ? 'text-warning' : 'text-foreground',
              )}
            >
              {headline}
            </p>
          </div>

          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>

          {/* Only stated at thread level when ONE person is awaited. With several,
              "asked by X, since Y" taken from the oldest request described somebody
              else's wait — most confusingly for the reader who is themselves
              awaited by a different person. Each row below carries both facts for
              its own request instead, so nothing is lost by narrowing this. */}
          {single && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {oldest.requestedBy && (
              <span>{t('mentions.awaiting.askedBy', { name: oldest.requestedBy.name })}</span>
            )}
            {/* "seit …" takes the EXACT moment, not a relative phrase: German
                "seit vor 15 Stunden" is broken, and precision is the house
                register anyway. The relative reading rides along on hover. */}
            <time dateTime={oldest.createdAt} title={formatRelativeTime(oldest.createdAt, locale)}>
              {t('mentions.awaiting.since', {
                time: formatAbsoluteTime(oldest.createdAt, locale),
              })}
            </time>
          </div>
          )}

          {/* The question that was asked, when there is one — far more useful than
              "you were mentioned" (MN-12). */}
          {single?.note && (
            <p className="mt-2 border-l border-border pl-2.5 text-sm leading-relaxed text-foreground/80">
              {single.note}
            </p>
          )}

          {/* Several people awaited: each one gets its own release, because the
              state resolves per person (MN-10). */}
          {!single && (
            <ul className="mt-2.5 flex flex-col divide-y rounded-lg border bg-background">
              {/* Releasing one person removes their row while the others stay. A CSS
                  `animate-in` can only play on mount, so without this the released
                  row vanished between frames and the rows below snapped upward —
                  the one moment in this banner where something the user just did
                  has a visible result. `popLayout` takes the leaving row out of
                  flow so the remainder closes the gap smoothly rather than after. */}
              <AnimatePresence initial={false} mode="popLayout">
                {pending.map((request) => (
                  <motion.li
                    key={request.id}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={springGentle}
                    data-testid="awaiting-person"
                    // The release label carries the person's name and `Button`
                    // refuses to wrap it, so at phone width the nowrap button won
                    // the width contest and truncated the name column — the one
                    // thing the row exists to show — to zero.
                    //
                    // `flex-wrap` alone does NOT fix that: a `flex-1` child has a
                    // flex-basis of 0, so its hypothetical main size is 0 and it
                    // never contributes to the line-breaking decision. The button
                    // still fits beside it at any width and still takes the lot.
                    // The name column needs a real basis to break against.
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-2.5 py-1.5"
                  >
                    <span className="flex min-w-0 grow basis-48 items-center gap-2">
                      <PersonAvatar person={request.person} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{request.person.name}</span>
                        {/* Both facts per row, because the thread-level line above
                            is only shown for a single request (see there) — the
                            asker AND how long this particular person has been
                            waited on. Same absolute-time reading as up there, for
                            the same reason. */}
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          {request.requestedBy && (
                            <span className="truncate">
                              {t('mentions.awaiting.askedBy', { name: request.requestedBy.name })}
                            </span>
                          )}
                          <time
                            dateTime={request.createdAt}
                            title={formatRelativeTime(request.createdAt, locale)}
                          >
                            {t('mentions.awaiting.since', {
                              time: formatAbsoluteTime(request.createdAt, locale),
                            })}
                          </time>
                        </span>
                      </span>
                    </span>
                    {/* The question, per person. It used to render only when
                        exactly one person was awaited, so the moment two people
                        were asked the thing they were asked disappeared.

                        Before the button in the DOM, `order-last` in the layout:
                        a screen reader follows source order, and reading "release
                        this person" before the question they were asked offers the
                        way out of a wait whose reason has not been said yet. */}
                    {request.note && (
                      <p className="order-last w-full border-l border-border pl-2.5 text-sm leading-relaxed text-foreground/80">
                        {request.note}
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                      disabled={releasing !== null}
                      // Two open requests can name the SAME person — asked twice,
                      // or by two colleagues — and then every button in this list
                      // reads "Continue without Anna Weber", with nothing to
                      // choose between them out of context. When the name repeats,
                      // the accessible name carries what actually differs.
                      aria-label={
                        repeatedNames.has(request.person.name)
                          ? t('mentions.awaiting.releaseOneSince', {
                              name: request.person.name,
                              time: formatAbsoluteTime(request.createdAt, locale),
                            })
                          : undefined
                      }
                      onClick={() => void release([request], request.id)}
                    >
                      {t('mentions.awaiting.releaseOne', { name: request.person.name })}
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* The reader's own move, so it leads. Only when THEY are the one
                being asked and there is a single asker to send it back to — with
                two askers "Rückfrage an wen?" has no honest answer, and the
                composer's own `@` is the right tool then. */}
            {awaitingMe && onAskBack && single?.requestedBy && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => onAskBack(single.requestedBy!)}
              >
                <CornerUpLeft className="size-3.5" aria-hidden />
                {t('mentions.awaiting.askBack', { name: single.requestedBy.name })}
              </Button>
            )}
            {onAskAgent && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={onAskAgent}
              >
                {t('mentions.awaiting.askAgent')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground hover:text-foreground"
              disabled={releasing !== null}
              // One outstanding request → release it by name. Several → release the
              // whole wait; any participant may do this (MN-9.2).
              onClick={() => void release(pending, 'all')}
            >
              {/* "Continue without Anna" only makes sense about someone ELSE. When
                  the thread is waiting on the reader, the neutral wording is the
                  honest one — they are still allowed to release it. */}
              {single && !awaitingMe
                ? t('mentions.awaiting.releaseOne', { name: single.person.name })
                : t('mentions.awaiting.release')}
            </Button>
          </div>

          {failed && (
            <p role="alert" className="mt-2 text-xs text-error">
              {t('mentions.errors.releaseFailed')}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
