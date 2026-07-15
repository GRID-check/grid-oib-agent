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
}

/**
 * "Confidence: high" — the assistant's OWN, guarded self-assessment of how well
 * an answer is grounded in its sources. Honest, deliberately subtle, and clearly
 * framed as a self-assessment that can be wrong (tooltip). Renders nothing when
 * absent, so historical messages, deep-research turns, and error turns show no
 * chip. Low uses the warning tone (sparingly) to nudge caution; medium/high stay
 * muted so a confident answer never shouts.
 */
export const ConfidenceChip: FC<ConfidenceChipProps> = ({ confidence }) => {
  const t = useTranslations('chat')

  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    return null
  }

  const levelLabel = t(`confidence.levels.${confidence}`)
  const label = t('confidence.label', { level: levelLabel })
  const variant = confidence === 'low' ? 'warning' : 'muted'

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
      <TooltipContent className="max-w-xs">{t('confidence.tooltip')}</TooltipContent>
    </Tooltip>
  )
}
