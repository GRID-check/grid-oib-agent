'use client'

/**
 * What this answer cost, in the unit the organization sees: the credits
 * ("Punkte") billed for it, or on the organization's own provider key the
 * tokens. One line in the answer's details, beside its time.
 *
 * Read from the ledger (`GET /api/conversations/:id/messages/:messageId/usage`),
 * where each generation's credits were frozen when it was recorded, so the
 * number here is the one the budget was charged. Mounted only while the
 * details are open, so a closed answer costs no request. The post-answer
 * stages land a moment after the answer, so a re-open can show a little more.
 */

import { type FC, useEffect, useState } from 'react'

import { useLocale, useTranslations } from '@/i18n'
import { formatCredits } from '@/lib/format'

interface AnswerUsageDto {
  unit: 'credit' | 'token'
  credits: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
}

interface AnswerCostProps {
  conversationId: string
  messageId: string
}

export const AnswerCost: FC<AnswerCostProps> = ({ conversationId, messageId }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const [usage, setUsage] = useState<AnswerUsageDto | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/usage`,
      { signal: controller.signal }
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { usage?: AnswerUsageDto | null } | null) => setUsage(body?.usage ?? null))
      .catch(() => undefined)
    return () => controller.abort()
  }, [conversationId, messageId])

  if (!usage) return null
  const tokens = new Intl.NumberFormat(locale)
  const label =
    usage.unit === 'credit'
      ? t('answerDetails.costCredits', { value: formatCredits(usage.credits, locale) })
      : t('answerDetails.costTokens', { value: tokens.format(usage.totalTokens) })
  const breakdown = t('answerDetails.costBreakdown', {
    prompt: tokens.format(usage.promptTokens),
    completion: tokens.format(usage.completionTokens),
    reasoning: tokens.format(usage.reasoningTokens),
  })

  return (
    <span className="text-subtle text-xs" data-testid="answer-cost" title={breakdown}>
      {label}
    </span>
  )
}
