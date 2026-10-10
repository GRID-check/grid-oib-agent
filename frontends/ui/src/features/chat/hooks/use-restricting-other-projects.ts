'use client'

/**
 * The other projects that restrict the open chat NOW (ADR-0094), read from the
 * server, for the composer's notice.
 *
 * Not derived from the answers' citations. A citation carries the project's
 * status as it was when the answer was written, and the server judges at read
 * time: a project closed since restricts nobody, one reopened restricts again,
 * and a restricted folder of any other project, a closed one's too, still does.
 * The conversation read (`GET /api/conversations/:id`) answers that with the
 * same repository functions the doors use, so the notice cannot disagree with
 * what the chat is refused.
 *
 * Read when the chat opens, once the server has it (a new chat has no row until
 * its first message), and again whenever no turn is running and a new answer
 * has landed: the lookup that narrows the chat records before it answers, so
 * by then the record holds it. A failed read keeps what was shown.
 */

import { useEffect, useState } from 'react'
import { conversationsClient, type RestrictingOtherProject } from '@/adapters/api/conversations-client'
import { useConversationOnServer } from '../lib/conversation-on-server'
import { useChatStore } from '../store'

const NONE: readonly RestrictingOtherProject[] = []

export function useRestrictingOtherProjects(conversationId: string | null | undefined): readonly RestrictingOtherProject[] {
  const [read, setRead] = useState<{ conversationId: string; projects: readonly RestrictingOtherProject[] } | null>(null)
  const onServer = useConversationOnServer(conversationId)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const newestAnswerId = useChatStore((state) => {
    const messages = state.currentConversation?.messages ?? []
    return messages.findLast((message) => message.role === 'assistant')?.id ?? null
  })

  useEffect(() => {
    if (!conversationId || !onServer || isStreaming) return
    let current = true
    void conversationsClient.restrictingOtherProjects(conversationId).then((projects) => {
      if (current && projects) setRead({ conversationId, projects })
    })
    return () => {
      current = false
    }
  }, [conversationId, onServer, isStreaming, newestAnswerId])

  // What was read belongs to its conversation: a switch shows nothing until the new read lands.
  return read !== null && read.conversationId === conversationId ? read.projects : NONE
}
