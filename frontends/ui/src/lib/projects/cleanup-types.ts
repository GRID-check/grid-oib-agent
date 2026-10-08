/**
 * The „Ausmisten" proposal as the wire carries it (ADR-0088). Isomorphic: the
 * close dialog reads it, `cleanup-service` builds it.
 */

import type { CleanupCategory, RuleCandidate } from './cleanup-rules'

export interface CleanupProposalItem {
  documentId: string
  filename: string
  folderPath: string | null
  category: CleanupCategory
  /** The model's reason, in the reader's language; null when only a rule proposed it. */
  aiReason: string | null
  /** The rule that matched, when one did. */
  rule: RuleCandidate['rule'] | null
}

export interface CleanupProposal {
  items: CleanupProposalItem[]
  /** How many documents the proposal looked at: those the reader may read and write. */
  considered: number
  /** Whether the model's proposal is part of this one (EU AI Act Art. 50: say so). */
  aiUsed: boolean
  /** Why the model's proposal is missing, when it is: the rules stood in. */
  aiError: string | null
}

/** The reason when a clean-out failed and could not be fully undone; `details.folders` names where to look. */
export const CLEANUP_PARTIALLY_UNDONE_REASON = 'cleanup-partially-undone'
