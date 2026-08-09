'use client'

/**
 * The Prüfbuch — OIB requirements with a verdict, on the model page.
 *
 * The rest of the model page answers "what is in this file". This answers
 * "where does it stand", which is the only question that ends up on a
 * Bestätigung.
 *
 * Three design commitments, each of which the UI has to make visible rather
 * than merely honour in the data:
 *
 * 1. **`Nicht entscheidbar` is shown as prominently as a failure**, because it
 *    is not a gap in the report — it is the reason the report cannot be
 *    trusted yet, and it is the architect's to-do list.
 * 2. **Every verdict shows the threshold it applied**, so the architect checks
 *    the rule and not only the result.
 * 3. **A rule that stood down says why**, on the row. "Gebäudeklasse nicht
 *    gesetzt" is a fixable state, and hiding the row would make an
 *    under-configured project look like a clean one.
 */

import { AlertTriangle, CheckCircle2, HelpCircle, MinusCircle, ShieldCheck, Wrench } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { BimComplianceSummary, BimRuleResult } from '@/lib/bim/rules'
import { buildModelHref } from '../lib/model-link'

export interface IfcCompliancePanelProps {
  rules: BimRuleResult[] | null
  summary: BimComplianceSummary | null
  shoppingList: Array<{ path: string; elements: number; rules: string[] }> | null
  isLoading: boolean
  error: string | null
  projectId: string
  modelFilename: string
  /** Set when the project brief is missing a fact some rules need. */
  missingFacts: string[]
  /** Opens the chat so the user can supply what the brief lacks. */
  askHref: string
}

/** Rows before a rule's list folds — the counts always speak for the rest. */
const VISIBLE_ROWS = 6

function verdictHref(
  projectId: string,
  modelFilename: string,
  globalIds: string[],
  status: 'fail' | 'info'
): string {
  return buildModelHref(projectId, {
    model: modelFilename,
    element: globalIds[0],
    highlights: [{ status, globalIds }],
    xray: true,
  })
}

export function IfcCompliancePanel({
  rules,
  summary,
  shoppingList,
  isLoading,
  error,
  projectId,
  modelFilename,
  missingFacts,
  askHref,
}: IfcCompliancePanelProps): JSX.Element {
  const t = useTranslations('bim')

  return (
    <section aria-labelledby="bim-compliance-heading" className="space-y-3">
      <h2 id="bim-compliance-heading" className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('compliance.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('compliance.description')}</p>

      {isLoading && <Spinner className="size-4" />}
      {error && <p className="text-sm text-destructive">{t('compliance.failed')}</p>}

      {summary && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="success">
            {t('compliance.badge.passing')} {summary.rulesPassing}
          </Badge>
          <Badge variant="destructive">
            {t('compliance.badge.failing')} {summary.rulesFailing}
          </Badge>
          {/* Same visual weight as a failure on purpose: an undecidable
              requirement is not a smaller problem, it is an unknown one. */}
          <Badge variant="warning">
            {t('compliance.badge.undecidable')} {summary.rulesUndecidable}
          </Badge>
          <Badge variant="secondary">
            {t('compliance.badge.notApplicable')} {summary.rulesNotApplicable}
          </Badge>
        </div>
      )}

      {missingFacts.length > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('compliance.missingFacts', { facts: missingFacts.join(', ') })}{' '}
            <Link href={askHref} className="underline underline-offset-2">
              {t('compliance.setFacts')}
            </Link>
          </span>
        </p>
      )}

      {shoppingList && shoppingList.length > 0 && (
        <div className="rounded-lg border p-3">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t('compliance.shoppingList.title')}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('compliance.shoppingList.description')}
          </p>
          <ul className="space-y-1 text-sm">
            {shoppingList.slice(0, 8).map((entry) => (
              <li key={entry.path} className="flex flex-wrap items-baseline gap-x-2">
                <code className="rounded bg-muted px-1 py-0.5 text-xs">{entry.path}</code>
                <span className="text-muted-foreground">
                  {t('compliance.shoppingList.count', { count: entry.elements })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rules && (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.ruleId}
              rule={rule}
              projectId={projectId}
              modelFilename={modelFilename}
            />
          ))}
        </ul>
      )}

      {rules && (
        <p className="text-xs text-muted-foreground">{t('compliance.disclaimer')}</p>
      )}
    </section>
  )
}

function RuleRow({
  rule,
  projectId,
  modelFilename,
}: {
  rule: BimRuleResult
  projectId: string
  modelFilename: string
}): JSX.Element {
  const t = useTranslations('bim')
  const checked = rule.passed + rule.failed + rule.undecidable

  const { Icon, tone } = !rule.applicable
    ? { Icon: MinusCircle, tone: 'text-muted-foreground' }
    : rule.failed > 0
      ? { Icon: AlertTriangle, tone: 'text-destructive' }
      : checked === 0
        ? { Icon: MinusCircle, tone: 'text-muted-foreground' }
        : rule.passed === 0
          ? { Icon: HelpCircle, tone: 'text-warning' }
          : { Icon: CheckCircle2, tone: 'text-success' }

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {rule.titleDe}{' '}
            <span className="font-normal text-muted-foreground">
              ({rule.richtlinie}, Punkt {rule.clause})
            </span>
          </p>
          {/* The threshold, always — the architect checks the rule, not only
              the verdict. */}
          <p className="text-xs text-muted-foreground">{rule.thresholdDe}</p>

          {!rule.applicable ? (
            // A rule that stood down says why. Hiding it would make an
            // under-configured project look like a clean one.
            <p className="text-xs text-muted-foreground">
              {t('compliance.notApplicable')}: {rule.notApplicableReason}
            </p>
          ) : checked === 0 ? (
            <p className="text-xs text-muted-foreground">{t('compliance.noElements')}</p>
          ) : (
            <>
              <p className="text-xs tabular-nums text-muted-foreground">
                {t('compliance.counts', {
                  passed: rule.passed,
                  failed: rule.failed,
                  undecidable: rule.undecidable,
                })}
              </p>
              <VerdictList
                heading={t('compliance.failures')}
                verdicts={rule.failures}
                projectId={projectId}
                modelFilename={modelFilename}
                status="fail"
                tone="text-destructive"
              />
              <VerdictList
                heading={t('compliance.unknowns')}
                verdicts={rule.unknowns}
                projectId={projectId}
                modelFilename={modelFilename}
                status="info"
                tone="text-warning"
              />
              {rule.truncated && (
                <p className="text-xs text-muted-foreground">{t('compliance.truncated')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function VerdictList({
  heading,
  verdicts,
  projectId,
  modelFilename,
  status,
  tone,
}: {
  heading: string
  verdicts: BimRuleResult['failures']
  projectId: string
  modelFilename: string
  status: 'fail' | 'info'
  tone: string
}): JSX.Element | null {
  const t = useTranslations('bim')
  if (verdicts.length === 0) return null
  const shown = verdicts.slice(0, VISIBLE_ROWS)

  return (
    <div className="mt-1 space-y-0.5">
      <p className={`text-xs font-medium ${tone}`}>
        {heading}{' '}
        <Link
          href={verdictHref(
            projectId,
            modelFilename,
            verdicts.map((verdict) => verdict.globalId),
            status
          )}
          className="font-normal underline underline-offset-2"
        >
          {t('compliance.showInModel')}
        </Link>
      </p>
      <ul className="space-y-0.5">
        {shown.map((verdict) => (
          <li key={verdict.globalId} className="text-xs text-muted-foreground">
            <Link
              href={verdictHref(projectId, modelFilename, [verdict.globalId], status)}
              className="underline underline-offset-2"
            >
              {verdict.name ?? verdict.globalId}
            </Link>
            {verdict.storeyName ? ` · ${verdict.storeyName}` : ''} — {verdict.reading}
          </li>
        ))}
      </ul>
      {verdicts.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          {t('compliance.more', { count: verdicts.length - shown.length })}
        </p>
      )}
    </div>
  )
}
