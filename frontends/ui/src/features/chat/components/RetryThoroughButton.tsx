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
 *
 * It fades in when it appears under an answer already on screen (the reader
 * just voted, or the thread's votes arrived): it is the consequence of the
 * vote, and popping in read as a glitch beside it. A button that is there
 * from the first paint has nothing to arrive from and paints at once.
 *
 * The level it steps up from is the one this answer RAN at
 * (`ChatMessage.reasoningEffort`: the terminal's resolved `reasoning_effort`,
 * else the asker's record from when the turn opened, stored with the answer's
 * provenance), so turning the dial after asking does not move the offer. An
 * answer without one (a row older than the field, a turn whose model sends no
 * level) falls back to the dial as it stands now: the best guess left, and the
 * level the chat would send anyway.
 */

import { useCallback, useEffect, useRef, type FC } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
  const ranAt = useChatStore(
    (s) => s.currentConversation?.messages.find((m) => m.id === messageId)?.reasoningEffort
  )
  const dial = useEffortStore((s) => effectiveEffort(s, conversationId))
  const original = ranAt ?? dial
  const busy = useIsCurrentSessionBusy()

  const target = thoroughEffortFor(original)
  const visible = state?.verdict === 'down' && !!send && !!question && !!target

  // Whether the button was already there on the first paint: only a button
  // that appears LATER fades in (see the module note).
  const shownAtMount = useRef<boolean | null>(null)
  useEffect(() => {
    if (shownAtMount.current === null) shownAtMount.current = visible
  }, [visible])
  const arrives = shownAtMount.current === false

  const handleClick = useCallback(() => {
    if (!send || !question || !target) return
    capturePosthog('answer_retry_thorough', { message_id: messageId, original_effort: original })
    send(question, { reasoningEffort: target })
  }, [send, question, target, messageId, original])

  if (!visible) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={busy}
      aria-label={t('retryThorough.aria')}
      className={cn(
        'h-6 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground/80 hover:text-foreground',
        arrives && 'animate-in fade-in-0 duration-quick ease-entrance motion-reduce:animate-none'
      )}
    >
      <RotateCcw className="size-3" aria-hidden="true" />
      {t('retryThorough.action')}
    </Button>
  )
}
