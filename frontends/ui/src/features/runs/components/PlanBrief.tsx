'use client'

/**
 * The plan read as a brief: its sections as an outline, and the Unterlagen it
 * reads and keeps out. One rendering for the folded plan on the run block and
 * the live preview in „Recherche planen", so the reader sees in the dialog
 * exactly what the block will show.
 */

import type { FC } from 'react'
import { useTranslations } from '@/i18n'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { OutlineRail, PlanDocLine } from './plan-atoms'

export const PlanBrief: FC<{
  sections: readonly string[]
  grundlage: readonly PlanDocument[]
  ausgeschlossen: readonly PlanDocument[]
  /** „Nur diese": the Grundlage is all of the reader's documents the run uses. */
  nurGrundlage?: boolean
  /** Fold the outline into its first rows. */
  limit?: number
  onMore?: () => void
  /** Shown in place of an outline that has no rows yet. */
  emptyLabel?: string
  testId?: string
}> = ({ sections, grundlage, ausgeschlossen, nurGrundlage = false, limit, onMore, emptyLabel, testId }) => {
  const t = useTranslations('runs')
  const tc = useTranslations('chat')
  return (
    <div className="flex flex-col gap-2.5">
      {sections.length === 0 && emptyLabel ? (
        <p className="text-muted-foreground text-xs italic">{emptyLabel}</p>
      ) : (
        <OutlineRail
          label={tc('agentPrompt.plan.points')}
          items={sections}
          limit={limit}
          moreLabel={(count) => t('plan.more', { count })}
          onMore={onMore}
          testId={testId}
        />
      )}
      <PlanDocLine
        label={
          nurGrundlage ? tc('agentPrompt.plan.unterlagen.grundlageOnly') : tc('agentPrompt.plan.unterlagen.grundlage')
        }
        docs={grundlage}
        testId="run-plan-grundlage"
      />
      <PlanDocLine
        label={tc('agentPrompt.plan.unterlagen.ausgeschlossen')}
        docs={ausgeschlossen}
        excluded
        testId="run-plan-ausgeschlossen"
      />
    </div>
  )
}
