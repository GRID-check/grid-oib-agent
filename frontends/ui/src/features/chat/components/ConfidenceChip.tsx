'use client'

import { type FC } from 'react'
import { Gauge } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'

/** The three self-assessment levels the model can report. */
export type AnswerConfidence = 'low' | 'medium' | 'high'

/**
 * Wire value → dictionary key. A lookup rather than a ternary chain so adding a
 * cause to {@link AnswerConfidenceCappedReason} fails to compile here until its
 * copy exists, instead of silently rendering no explanation for the cap.
 */
const CAPPED_REASON_KEYS: Record<AnswerConfidenceCappedReason, string> = {
  ungrounded: 'ungrounded',
  quote_unverified: 'quoteUnverified',
  normative_claim_uncited: 'normativeClaimUncited',
  measurement_only: 'measurementOnly',
  citation_fallback: 'citationFallback',
}

interface ConfidenceChipProps {
  /** The model's guarded self-assessment; undefined/null renders nothing. */
  confidence: AnswerConfidence | null | undefined
  /**
   * Why the self-assessment was capped (WP-A transparency extra), appended as an
   * extra sentence to the tooltip so the cap is explained rather than silent
   * (PB-9). See {@link AnswerConfidenceCappedReason} for the causes it can
   * carry; the type is the list, so no count is restated here to go stale.
   */
  cappedReason?: AnswerConfidenceCappedReason
  /**
   * The model's own one-clause justification for its level
   * (`[CONFIDENCE:level | reason]`), shown verbatim in the tooltip so the
   * reader can see WHY the level was chosen. Absent on older turns and when
   * the marker carried no reason.
   */
  reason?: string
}

/**
 * "Confidence: high" — the assistant's OWN, guarded self-assessment of how well
 * an answer is grounded in its sources. Honest, deliberately subtle, and clearly
 * framed as a self-assessment that can be wrong (tooltip). Renders nothing when
 * absent, so historical messages, deep-research turns, and error turns show no
 * chip. Low uses the warning tone (sparingly) to nudge caution; medium/high stay
 * muted so a confident answer never shouts.
 *
 * The tooltip explains the chip in full: what the level means, the model's own
 * reason (when given), the self-assessment caveat, and any deterministic cap.
 */
export const ConfidenceChip: FC<ConfidenceChipProps> = ({ confidence, cappedReason, reason }) => {
  const t = useTranslations('chat')

  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    return null
  }

  const levelLabel = t(`confidence.levels.${confidence}`)
  const label = t('confidence.label', { level: levelLabel })
  const variant = confidence === 'low' ? 'warning' : 'muted'
  // When the confidence was capped, explain WHY in the tooltip (PB-9) instead of
  // leaving the downgrade silent. Fail-open: an absent/unknown reason keeps the
  // generic tooltip.
  const cappedReasonText = cappedReason
    ? t(`confidence.cappedReasons.${CAPPED_REASON_KEYS[cappedReason]}`)
    : undefined
  // Trim only to DETECT an empty/whitespace-only reason; the reason itself is
  // rendered verbatim, as the wire contract promises.
  const displayReason = reason?.trim() ? reason : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          asChild
          variant={variant}
          size="sm"
          interactive
          aria-label={t('confidence.ariaLabel', { level: levelLabel })}
        >
          <button type="button">
            <Gauge aria-hidden="true" />
            {label}
          </button>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="block">{t(`confidence.levelMeanings.${confidence}`)}</span>
        {displayReason ? (
          <span className="mt-1 block">
            <span className="font-medium">
              {t(cappedReason ? 'confidence.reasonLabelBeforeCap' : 'confidence.reasonLabel')}:
            </span>{' '}
            {displayReason}
          </span>
        ) : null}
        <span className="mt-1 block">{t('confidence.tooltip')}</span>
        {cappedReasonText ? <span className="mt-1 block">{cappedReasonText}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}
