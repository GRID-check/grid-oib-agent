'use client'

import { type FC } from 'react'
import { Gauge } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'

/** The three self-assessment levels the model can report. */
export type AnswerConfidence = 'low' | 'medium' | 'high'

interface ConfidenceChipProps {
  /** The model's guarded self-assessment; undefined/null renders nothing. */
  confidence: AnswerConfidence | null | undefined
  /**
   * Why the self-assessment was capped (WP-A transparency extra), appended as an
   * extra sentence to the tooltip so the cap is explained rather than silent
   * (PB-9). `'ungrounded'` = the answer is not grounded in verified sources;
   * `'quote_unverified'` = a quoted span could not be confirmed verbatim in the
   * source.
   */
  cappedReason?: 'ungrounded' | 'quote_unverified'
}

/**
 * "Confidence: high" — the assistant's OWN, guarded self-assessment of how well
 * an answer is grounded in its sources. Honest, deliberately subtle, and clearly
 * framed as a self-assessment that can be wrong (tooltip). Renders nothing when
 * absent, so historical messages, deep-research turns, and error turns show no
 * chip. Low uses the warning tone (sparingly) to nudge caution; medium/high stay
 * muted so a confident answer never shouts.
 */
export const ConfidenceChip: FC<ConfidenceChipProps> = ({ confidence, cappedReason }) => {
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
  const cappedReasonText =
    cappedReason === 'ungrounded'
      ? t('confidence.cappedReasons.ungrounded')
      : cappedReason === 'quote_unverified'
        ? t('confidence.cappedReasons.quoteUnverified')
        : undefined
  const tooltip = cappedReasonText
    ? `${t('confidence.tooltip')} ${cappedReasonText}`
    : t('confidence.tooltip')

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
      <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
