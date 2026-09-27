/**
 * TechnicalSteps — every Herleitung row in order, a power-user opt-in
 * (profile setting `showTechnicalReasoning`). Rendered as a collapsible tail
 * below the reasoning graph.
 *
 * "Technical" is about the GRANULARITY — every step the backend sent, with its
 * timestamp. A tool is named in the reader's nouns where the chip row has one
 * (`stepNameLabel`), and otherwise by its basename; a status slot and a skill id
 * are identifiers a power user came for, and show verbatim.
 */

'use client'

import type { FC } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { stepNameLabel } from '../../lib/executed-steps'
import type { StoredThinkingStep } from '../../lib/turn-fold'

/** The row label for one stored step. */
export const technicalStepLabel = (step: StoredThinkingStep, t: Translator): string => {
  switch (step.kind) {
    case 'tool':
    case 'sources':
      return (step.tool && stepNameLabel(step.tool, t)) || step.tool || step.kind
    case 'status':
      return step.slot ?? step.kind
    case 'retrieval':
      return `retrieval:${step.round ?? ''}`
    case 'skill':
      return step.skill ?? t('thinking.nodeName.skillSelection')
    case 'clarification':
      return t('thinking.nodeName.clarification')
  }
}

export const TechnicalSteps: FC<{ steps: StoredThinkingStep[]; t: Translator }> = ({
  steps,
  t,
}) => (
  <Collapsible>
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="focus-visible:ring-ring/60 group flex w-full items-center justify-between rounded-lg py-1 text-left outline-none focus-visible:ring-2"
      >
        <SectionLabel>{t('thinking.stepsHeading')}</SectionLabel>
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <span>{steps.length}</span>
          <ChevronDown className="duration-quick size-3.5 transition-transform ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
        </span>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div role="list" aria-label={t('thinking.stepsLabel')} className="pt-1">
        {steps.map((step) => (
          <div
            key={step.id}
            className="border-base ml-1 flex w-full items-center justify-between border-l-2 py-1.5 pl-4"
            role="listitem"
          >
            <span className="text-foreground min-w-0 truncate text-sm">
              {technicalStepLabel(step, t)}
            </span>
            <span className="text-muted-foreground shrink-0 pl-4 text-xs">
              {formatTime(step.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </CollapsibleContent>
  </Collapsible>
)
