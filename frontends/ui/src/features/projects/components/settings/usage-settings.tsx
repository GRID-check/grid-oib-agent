'use client'

/**
 * Settings → Usage & budget: what this project has cost, and the limit that
 * stops Piloti in it.
 *
 * This replaces the page's old "Insights" card, which was an empty state
 * promising evaluation that did not exist. The data did: every LLM call is
 * metered with its project id, and a project-scoped budget policy has been
 * enforceable since ADR-0015, settable by the project's own admins. The one
 * place to set it was the organization's budget page, which a project admin
 * usually cannot open.
 *
 * Amounts are in the organization's unit (credits, or tokens on its own key)
 * and never in money: `getProjectUsage` reuses the tenant projection that keeps
 * cost and price off every tenant surface. The meters are the organization
 * card's own, so "how close am I to being stopped" reads the same in both.
 */

import type { JSX } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Pencil } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemList, ItemTitle } from '@/components/ui/item'
import { BudgetMeter } from '@/features/budgets/components/budget-meter'
import { LimitEditor } from '@/features/budgets/components/limit-editor'
import { useLocale, useTranslations } from '@/i18n'
import { formatCredits, formatTokens } from '@/lib/format'
import { SettingsPanel } from './settings-panel'

type BudgetUnit = 'credit' | 'token'

interface Limits {
  dailyLimit: number | null
  monthlyLimit: number | null
}

interface UsageWindow {
  amount: number
  events: number
}

/** `ProjectUsage` from `lib/budgets/service`, as it crosses to the browser. */
export interface ProjectUsageView {
  unit: BudgetUnit
  day: UsageWindow
  month: UsageWindow
  perModel: Array<{ model: string; month: UsageWindow }>
  projectLimit: Limits | null
  orgLimit: Limits
  blockedScope: 'organization' | 'member' | 'project' | null
}

export interface UsageSettingsProps {
  projectId: string
  usage: ProjectUsageView
  /** May set or remove the project limit (`project:manage`, or an org budget admin). */
  canEditLimit: boolean
}

/** The tighter of two limits for one window; null only when neither sets one. */
function effectiveLimit(project: number | null, org: number | null): number | null {
  if (project === null) return org
  if (org === null) return project
  return Math.min(project, org)
}

export function UsageSettings({ projectId, usage, canEditLimit }: UsageSettingsProps): JSX.Element {
  const t = useTranslations('settings')
  const tOrg = useTranslations('organization')
  const { locale } = useLocale()
  const router = useRouter()

  const onOwnKey = usage.unit === 'token'
  const amountLabel = (value: number): string =>
    tOrg(onOwnKey ? 'budgets.tokensValue' : 'budgets.creditsValue', {
      value: onOwnKey ? formatTokens(value, locale) : formatCredits(value, locale),
    })
  const unitWord = tOrg(onOwnKey ? 'budgets.unitTokens' : 'budgets.unitCredits')
  const limitsLabel = (limits: Limits): string | null => {
    const parts: string[] = []
    if (limits.dailyLimit !== null)
      parts.push(`${amountLabel(limits.dailyLimit)}/${tOrg('budgets.perDay')}`)
    if (limits.monthlyLimit !== null)
      parts.push(`${amountLabel(limits.monthlyLimit)}/${tOrg('budgets.perMonth')}`)
    return parts.length > 0 ? parts.join(' · ') : null
  }

  const projectLimit = usage.projectLimit
  const orgLimitText = limitsLabel(usage.orgLimit)
  const blocked =
    usage.blockedScope === 'project'
      ? t('project.usage.blockedProject')
      : usage.blockedScope === 'organization'
        ? t('project.usage.blockedOrganization')
        : null

  return (
    <div className="flex flex-col gap-6">
      <SettingsPanel title={t('project.usage.title')} description={t('project.usage.description')}>
        <div className="flex flex-col gap-5">
          {blocked && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{blocked}</AlertDescription>
            </Alert>
          )}

          {/* `grid-spend-viz` scopes the validated meter tokens (globals.css). */}
          <div className="grid-spend-viz grid gap-5 sm:grid-cols-2">
            <BudgetMeter
              title={t('project.usage.today')}
              total={usage.day.amount}
              limit={effectiveLimit(projectLimit?.dailyLimit ?? null, usage.orgLimit.dailyLimit)}
              formatAmount={amountLabel}
            />
            <BudgetMeter
              title={t('project.usage.thisMonth')}
              total={usage.month.amount}
              limit={effectiveLimit(
                projectLimit?.monthlyLimit ?? null,
                usage.orgLimit.monthlyLimit
              )}
              formatAmount={amountLabel}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('project.usage.byModelTitle')}</h3>
            {usage.perModel.length > 0 ? (
              <ItemList>
                {usage.perModel.map((entry) => (
                  <Item key={entry.model}>
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">{entry.model}</ItemTitle>
                    </ItemContent>
                    <ItemActions className="text-muted-foreground gap-4 text-xs tabular-nums">
                      <span>{t('project.usage.requests', { count: entry.month.events })}</span>
                      <span className="text-foreground">{amountLabel(entry.month.amount)}</span>
                    </ItemActions>
                  </Item>
                ))}
              </ItemList>
            ) : (
              <EmptyState variant="bare" title={t('project.usage.empty')} className="py-4" />
            )}
          </div>
        </div>
      </SettingsPanel>

      <SettingsPanel
        title={t('project.usage.limitTitle')}
        description={t('project.usage.limitDescription')}
        action={
          canEditLimit ? (
            <LimitEditor
              scope="project"
              subjectId={projectId}
              current={
                projectLimit
                  ? {
                      dailyLimit: projectLimit.dailyLimit?.toString() ?? null,
                      monthlyLimit: projectLimit.monthlyLimit?.toString() ?? null,
                    }
                  : undefined
              }
              unitWord={unitWord}
              onSaved={async () => router.refresh()}
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil className="size-3.5" aria-hidden />
                  {projectLimit ? t('project.usage.editLimit') : t('project.usage.setLimit')}
                </Button>
              }
            />
          ) : undefined
        }
      >
        <div className="space-y-1 text-sm">
          <p className="font-medium tabular-nums" data-testid="project-limit">
            {(projectLimit && limitsLabel(projectLimit)) ?? t('project.usage.noProjectLimit')}
          </p>
          <p className="text-muted-foreground text-xs">
            {orgLimitText
              ? t('project.usage.orgCeiling', { limits: orgLimitText })
              : t('project.usage.orgCeilingNone')}
          </p>
        </div>
      </SettingsPanel>
    </div>
  )
}
