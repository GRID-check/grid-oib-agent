'use client'

/**
 * A colleague's turn, live.
 *
 * This is the surface `TurnInFlightBanner` was standing in for. The banner says
 * *something is happening*; this shows *what*: the reasoning as it is done and
 * the answer as it is written, the same two things the person who asked is
 * looking at. That difference is the whole point — a shared thread where one
 * person watches a spinner for ninety seconds while the other watches an answer
 * appear is not a shared thread, it is two different products.
 *
 * ## What it deliberately does NOT do
 *
 *  - **It is not interactive.** If the agent asked the asker something, an
 *    observer is told that the thread is waiting on them; the prompt is not
 *    theirs to answer (the server refuses it anyway — a control that always fails
 *    is worse than none).
 *  - **It is not the answer.** Nothing here is persisted or citable. The real
 *    message lands over the ordinary message path a moment later and replaces
 *    this entirely — with its citations, confidence, cards and feedback controls,
 *    none of which are rendered here precisely because they would be a
 *    lower-fidelity copy of the thing about to arrive.
 *  - **It never blocks the fallback.** The caller keeps the banner whenever this
 *    has nothing to show, so a missing cache tier, a dropped stream or a gated
 *    org degrades to exactly the previous behaviour.
 */

import type { FC } from 'react'
import type { PluggableList } from 'unified'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { remarkCardMarkers } from '@/features/grid-cards/card-markers'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SpectatedTurnState } from '../lib/spectator-frames'

/**
 * A spectator sees the answer's prose, never its cards — this view carries no
 * `cards` array to draw. Running the marker plugin with a count of zero strips
 * every `[[card:N]]` the asker's answer placed, so the spectator reads the
 * answer instead of its wiring.
 */
const STRIP_CARD_MARKERS: PluggableList = [[remarkCardMarkers, { count: 0 }]]

export interface SpectatedTurnProps {
  /** The turn so far. */
  turn: SpectatedTurnState
  /** "Piloti is answering Anna's question…" — resolved by the caller, which owns the roster. */
  label: string
  className?: string
}

export const SpectatedTurn: FC<SpectatedTurnProps> = ({ turn, label, className }) => {
  const t = useTranslations('collaboration')

  return (
    <div
      className={cn('flex w-full flex-col gap-2', className)}
      data-testid="spectated-turn"
      role="status"
      // The answer rewrites itself token by token. Announcing every mutation
      // would make the thread unusable with a screen reader, so the live region
      // is off here and the arrival announcement on the finished message (CC-9)
      // is what reports the answer — once, when it is complete and readable.
      aria-live="off"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'text-foreground text-xs font-medium',
            // The shimmer says "still working". It stops the moment the terminal
            // frame lands, so the last second before the persisted answer swaps in
            // does not look like a stall.
            !turn.done && 'animate-text-shimmer'
          )}
        >
          {label}
        </span>
      </div>

      {/* The reasoning chain, in the same panel the asker gets. Collapsed by
      default: an observer opting in to the detail is a click, an observer having
      it forced on them is noise in someone else's conversation. */}
      {turn.steps.length > 0 && (
        <ChatThinking steps={turn.steps} isThinking={!turn.done} isWaiting={Boolean(turn.waitingOn)} />
      )}

      {/* Piloti put a question to the asker. Stated, not offered. */}
      {turn.waitingOn && (
        <p className="text-muted-foreground bg-muted rounded-lg px-3 py-2 text-xs">
          {t('thread.spectatorPrompt', { question: turn.waitingOn })}
        </p>
      )}

      {turn.failed && (
        <p className="text-muted-foreground text-xs">{t('thread.spectatorFailed')}</p>
      )}

      {turn.answer && (
        <div className="text-foreground text-sm">
          <MarkdownRenderer
            content={turn.answer}
            isStreaming={!turn.done}
            compact
            remarkPlugins={STRIP_CARD_MARKERS}
          />
          {/* A caret, so a pause between tokens reads as "still writing" rather
          than as a finished — and oddly truncated — answer. */}
          {!turn.done && (
            <span
              className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-[2px] animate-pulse align-text-bottom"
              aria-hidden="true"
            />
          )}
        </div>
      )}
    </div>
  )
}
