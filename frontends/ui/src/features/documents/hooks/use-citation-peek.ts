'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '@/features/chat/store'
import {
  latestFinishedAssistantMessage,
  peekableFileForMessage,
} from '@/features/chat/lib/citation-peek'
import { openFilePeek } from '../lib/open-file-peek'
import { useSurfacedDocuments } from './use-surfaced-documents'

/**
 * Open the chat peek when the current thread's latest finished answer cites
 * exactly one project or Büroarchiv document.
 *
 * Mount once (project chat / MainLayout), never per card. A ref keyed by
 * message id is the hide-guard: hide() must not be undone by a later render
 * of the same answer. The composer bar stays after hide so the user can
 * still see they are asking about this file.
 */
export function useCitationPeek(options: {
  projectId: string | null
  projectName?: string | null
  canCollaborate?: boolean
}): void {
  const { projectId, projectName, canCollaborate } = options
  const messages = useChatStore((state) => state.currentConversation?.messages)
  const handledMessageId = useRef<string | null>(null)

  const decision = useMemo(() => {
    const message = latestFinishedAssistantMessage(messages)
    if (!message) return null
    return { messageId: message.id, peek: peekableFileForMessage(message) }
  }, [messages])

  const surfaced = useMemo(
    () =>
      decision?.peek
        ? [{ file_name: decision.peek.fileName, source: decision.peek.source }]
        : [],
    [decision],
  )
  const { resolved, isLoading } = useSurfacedDocuments(surfaced, projectId)

  useEffect(() => {
    if (!decision) return
    if (handledMessageId.current === decision.messageId) return

    if (!decision.peek) {
      handledMessageId.current = decision.messageId
      return
    }
    if (isLoading) return

    handledMessageId.current = decision.messageId
    const file = resolved[0]?.file
    if (!file) return

    openFilePeek({
      file,
      source: decision.peek.source,
      projectId,
      projectName,
      canCollaborate,
    })
  }, [decision, isLoading, resolved, projectId, projectName, canCollaborate])
}
