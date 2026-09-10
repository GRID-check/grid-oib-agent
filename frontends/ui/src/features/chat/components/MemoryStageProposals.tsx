'use client'

/**
 * Firm-wide findings the POST-ANSWER reflection pass proposed (ADR-0055, C6).
 *
 * A reflection pass runs after the answer is finished, when the turn's card
 * registry is already unbound — so an organization-scoped finding it wants to
 * offer cannot ride the answer's `cards` array and comes down the stage frame
 * instead (`shared/stages/frames.json`, `memory_reflection.ready`). This is the
 * render site for that half.
 *
 * ## It renders the STAGE's proposals only
 *
 * `turnMemoryProposals` merges both producers into one list precisely so the
 * reader is offered one thing in one shape; the in-turn half of that list is
 * already on screen, drawn by `GridCards` off `message.cards`. Drawing it again
 * here would be the second lookalike the merge exists to prevent, so this
 * component takes the merged list and renders only what `GridCards` cannot see.
 *
 * ## A proposal is not a write
 *
 * Nothing here claims a note exists. The card asks, `useCardDecision` keeps the
 * answer on the owning message, and only an accepted proposal ever appears in
 * the "Piloti hat sich gemerkt" list — which is `turnMemoryItems`' rule, not
 * this component's.
 */

import { type FC } from 'react'

import { MemoryProposalCard } from '@/features/grid-cards/components/MemoryProposalCard'
import type { TurnMemoryProposal } from '../lib/turn-memory'

export interface MemoryStageProposalsProps {
  /** The merged offer list from `turnMemoryProposals`. */
  proposals: readonly TurnMemoryProposal[]
  /** The message the decisions are kept on. Without one the card takes none. */
  messageId?: string
}

export const MemoryStageProposals: FC<MemoryStageProposalsProps> = ({ proposals, messageId }) => {
  const fromStage = proposals.filter((proposal) => proposal.origin === 'distillation')
  if (fromStage.length === 0) return null

  return (
    <div className="flex w-full flex-col gap-2" data-testid="memory-stage-proposals">
      {fromStage.map((proposal) => (
        <MemoryProposalCard
          key={proposal.key}
          title={proposal.card.title}
          content={proposal.card.content}
          kind={proposal.card.kind}
          confidence={proposal.card.confidence}
          messageId={messageId}
          cardKey={proposal.key}
          // The answer has landed, so this card always has a message to keep
          // its answer on — and it must not offer buttons if it somehow does
          // not, because `/api/organization/memory` inserts unconditionally.
          decisionsMustPersist
        />
      ))}
    </div>
  )
}
