/**
 * TechnicalSteps — the raw NAT intermediate-step list, a power-user opt-in
 * (profile setting `showTechnicalReasoning`). Rendered as a collapsible tail
 * below the reasoning graph; the default trace is the friendly node graph, never
 * "which agent is running".
 */

'use client'

import type { FC } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import type { ThinkingStep } from '../../types'

export const TechnicalSteps: FC<{ steps: ThinkingStep[]; t: Translator }> = ({ steps, t }) => (
  <Collapsible>
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="group flex w-full items-center justify-between rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <SectionLabel>{t('thinking.stepsHeading')}</SectionLabel>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{steps.length}</span>
          <ChevronDown className="size-3.5 transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
        </span>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div role="list" aria-label={t('thinking.stepsLabel')} className="pt-1">
        {steps.map((step) => {
          const isWorkflowRoot = step.functionName === 'chat_deepresearcher_agent'
          const isFunctionStep = step.isTopLevel === true
          const indentClass = isWorkflowRoot
            ? ''
            : isFunctionStep
              ? 'pl-4 border-l-2 border-base ml-1'
              : 'pl-8 border-l-2 border-base ml-1'
          return (
            <div
              key={step.id}
              className={`flex w-full items-center justify-between py-1.5 ${indentClass}`}
              role="listitem"
            >
              <span className="min-w-0 truncate text-sm text-foreground">{step.displayName}</span>
              <span className="shrink-0 pl-4 text-xs text-muted-foreground">
                {formatTime(step.timestamp)}
              </span>
            </div>
          )
        })}
      </div>
    </CollapsibleContent>
  </Collapsible>
)
