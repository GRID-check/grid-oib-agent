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
 *  - **It is not the answer.** Nothing here is persisted. The real message
 *    lands over the ordinary message path a moment later and replaces this.
 *    What it shows until then is the asker's own answer surface, fed by the
 *    same live frames (ADR-0066): the masthead before the first word, the
 *    citations once verified, the cards as each is written, all gated by the
 *    backend before they are sent. A compact, card-less preview here made the
 *    swap to the persisted answer a jump from one layout to another; the same
 *    `AgentResponse` makes it a swap of like for like. It is drawn
 *    `readOnly`: no feedback, no copy controls (the persisted answer that
 *    replaces it carries its own) and no card decisions. A card that acts is
 *    not even delivered here (`spectator-frames.ts`, rule 4); `readOnly` is
 *    the second wall, so one that slipped through still has nothing to press
 *    and no project of the observer's to write to.
 *  - **It never blocks the fallback.** The caller keeps the banner whenever this
 *    has nothing to show, so a missing cache tier, a dropped stream or a gated
 *    org degrades to exactly the previous behaviour.
 */

import type { FC } from 'react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SpectatedTurnState } from '../lib/spectator-frames'

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
        {/* The shimmer says "still working". It stops the moment the terminal
            frame lands, so the last second before the persisted answer swaps in
            does not look like a stall. */}
        <ShimmerText active={!turn.done} className="text-foreground text-xs font-medium">
          {label}
        </ShimmerText>
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

      {(turn.answer || turn.answerMeta || turn.cards?.some((card) => card !== undefined)) && (
        <AgentResponse
          content={turn.answer}
          isStreaming={!turn.done}
          answerMeta={turn.answerMeta}
          citations={turn.citations}
          cards={turn.cards}
          readOnly
        />
      )}
    </div>
  )
}
