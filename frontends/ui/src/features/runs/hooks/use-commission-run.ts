/**
 * Commission a research run from inside a thread and show its block.
 *
 * Two callers: an open finding in a Befundmatrix („Klären"), and a finished
 * report („Bericht fortschreiben"). The BFF mints the run's message in this
 * conversation; the thread is re-read so the block appears where the reader
 * is, and the run block then follows the run's own ledger stream.
 */

import { useCallback, useState } from 'react'
import { useChatStore } from '@/features/chat/store'
import { commissionRun } from '@/lib/runs/run-view-client'
import type { PlanDocuments } from '@/lib/runs/plan-documents'

export interface CommissionRunHandle {
  commission: (question: string, context?: string, documents?: PlanDocuments) => Promise<boolean>
  pending: boolean
}

export function useCommissionRun(
  projectId: string | null,
  conversationId: string | null
): CommissionRunHandle | null {
  const hydrate = useChatStore((s) => s.hydrateConversationMessages)
  const [pending, setPending] = useState(false)
  const commission = useCallback(
    async (question: string, context?: string, documents?: PlanDocuments): Promise<boolean> => {
      if (!projectId || !conversationId) return false
      setPending(true)
      try {
        await commissionRun(projectId, { conversationId, question, context, documents })
        await hydrate(conversationId)
        return true
      } catch {
        // Fail-open like every run action: the reader can try again, and
        // nothing on screen has claimed a run that does not exist.
        return false
      } finally {
        setPending(false)
      }
    },
    [projectId, conversationId, hydrate]
  )
  if (!projectId || !conversationId) return null
  return { commission, pending }
}
