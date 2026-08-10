'use client'

/**
 * What a revision changed about the building's standing.
 *
 * The revision timeline already says a revision happened — "+17 Bauteile" — and
 * the element diff already says which walls moved. Neither answers the question
 * an architect actually has when they re-export: **did I break something.**
 *
 * This does, and it is the one answer in the product that no other tool a small
 * office can afford will give them. It runs on demand rather than on load,
 * because it reads both revisions' full element sets.
 *
 * Only what MOVED is listed. A change list that restates every requirement is a
 * list nobody reads, and the point of this screen is that it is usually short
 * and occasionally alarming.
 */

import { ArrowRight, GitCompare, TrendingDown, TrendingUp, HelpCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { BimComplianceChange, BimComplianceTrend } from '@/lib/bim/rules'
import type { BimModelHeaderView } from '../hooks/use-bim-model'

export interface IfcComplianceDiffProps {
  /** The older revision this runs against; `null` when there is no previous. */
  baseModel: BimModelHeaderView | null
  changes: BimComplianceChange[] | null
  isLoading: boolean
  error: string | null
  onRun: () => void
}

/**
 * Regressions read as bad, improvements as good, and `undecidable` as a warning
 * rather than as neutral — losing the ability to check something is a change in
 * the wrong direction even though no verdict got worse.
 */
const TREND_STYLE: Record<
  BimComplianceTrend,
  { variant: 'destructive' | 'warning' | 'success' | 'secondary'; Icon: typeof TrendingDown }
> = {
  broken: { variant: 'destructive', Icon: TrendingDown },
  undecidable: { variant: 'warning', Icon: HelpCircle },
  moved: { variant: 'warning', Icon: ArrowRight },
  decidable: { variant: 'success', Icon: TrendingUp },
  resolved: { variant: 'success', Icon: TrendingUp },
}

export function IfcComplianceDiff({
  baseModel,
  changes,
  isLoading,
  error,
  onRun,
}: IfcComplianceDiffProps): JSX.Element | null {
  const t = useTranslations('bim')
  if (!baseModel) return null

  return (
    <section aria-labelledby="bim-compliance-diff-heading" className="space-y-2">
      <h2
        id="bim-compliance-diff-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <GitCompare className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('complianceDiff.title')}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t('complianceDiff.description', { previous: baseModel.filename })}
      </p>

      <Button type="button" size="sm" variant="secondary" onClick={onRun} disabled={isLoading}>
        {isLoading ? <Spinner className="size-3" /> : null}
        {isLoading ? t('complianceDiff.running') : t('complianceDiff.run')}
      </Button>

      {error && <p className="text-sm text-destructive">{t('complianceDiff.failed')}</p>}

      {changes && changes.length === 0 && (
        // Not an empty state — a result, and a reassuring one.
        <p className="text-sm text-muted-foreground">{t('complianceDiff.unchanged')}</p>
      )}

      {changes && changes.length > 0 && (
        <ul className="space-y-2">
          {changes.map((change) => {
            const { variant, Icon } = TREND_STYLE[change.trend]
            return (
              <li key={change.ruleId} className="rounded-lg border p-2.5">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">{change.titleDe}</span>
                  <span className="text-xs text-muted-foreground">{change.richtlinie}</span>
                  <Badge variant={variant}>{t(`complianceDiff.trend.${change.trend}`)}</Badge>
                </p>
                {/* Both sides, always: "broken" without the numbers is a claim,
                    with them it is evidence. */}
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {t('complianceDiff.counts', {
                    beforePassed: change.before.passed,
                    beforeFailed: change.before.failed,
                    beforeUndecidable: change.before.undecidable,
                    afterPassed: change.after.passed,
                    afterFailed: change.after.failed,
                    afterUndecidable: change.after.undecidable,
                  })}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
