'use client'

/**
 * RetryThoroughButton — the one quiet action under a down-voted answer.
 *
 * "Gründlicher neu beantworten" re-asks the question this answer replied to,
 * in the same conversation, with the Aufwand raised for that ONE turn: `high`
 * from anything below it, `xhigh` from `high`, and nothing at `xhigh` (there is
 * no thorougher level to offer, so the action is hidden rather than repeating
 * the same run). The level travels as a per-turn override on the live send
 * path (`chatSendFn`, `SendMessageOptions.reasoningEffort`); the reader's
 * remembered dial is never written.
 *
 * Ghost, small, muted ink at feedback-footnote weight: it sits in the meta row
 * beside the thumbs and must not read as a second call to action. It renders
 * only for a confirmed 'down' verdict, a send path, and a question to re-ask.
 */

import { useCallback, type FC } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { ChatEffort } from '@/lib/reasoning-settings/catalog'
import { useAnswerFeedback } from '../hooks/use-answer-feedback'
import { useIsCurrentSessionBusy } from '../hooks/use-current-session-busy'
import { useChatStore } from '../store'
import { effectiveEffort, useEffortStore } from '../stores/effort-store'

/** The level one thorough retry runs at, or null when none is higher. */
export function thoroughEffortFor(original: ChatEffort): ChatEffort | null {
  if (original === 'xhigh') return null
  return original === 'high' ? 'xhigh' : 'high'
}

export interface RetryThoroughButtonProps {
  messageId: string
  conversationId?: string | null
}

export const RetryThoroughButton: FC<RetryThoroughButtonProps> = ({ messageId, conversationId }) => {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)
  const { state } = useAnswerFeedback(messageId, conversationId, projectId)
  const send = useChatStore((s) => s.chatSendFn)
  const question = useChatStore((s) => {
    const messages = s.currentConversation?.messages ?? []
    const at = messages.findIndex((m) => m.id === messageId)
    if (at < 0) return null
    const asked = messages
      .slice(0, at)
      .findLast((m) => m.messageType === 'user' || m.role === 'user')
    return asked?.content?.trim() || null
  })
  const original = useEffortStore((s) => effectiveEffort(s, conversationId))
  const busy = useIsCurrentSessionBusy()

  const target = thoroughEffortFor(original)

  const handleClick = useCallback(() => {
    if (!send || !question || !target) return
    capturePosthog('answer_retry_thorough', { message_id: messageId, original_effort: original })
    send(question, { reasoningEffort: target })
  }, [send, question, target, messageId, original])

  if (state?.verdict !== 'down' || !send || !question || !target) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={busy}
      aria-label={t('retryThorough.aria')}
      className="h-6 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground/80 hover:text-foreground"
    >
      <RotateCcw className="size-3" aria-hidden="true" />
      {t('retryThorough.action')}
    </Button>
  )
}
