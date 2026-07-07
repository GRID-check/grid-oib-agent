'use client'

/**
 * Usage & budgets (ADR-0015): per-model LLM spend as stacked budget meters
 * (today / this month) with a hoverable, color-coded legend, the org limit
 * editor, and member/project limits chosen from real pickers (WorkOS member
 * directory + org projects) instead of raw ids.
 *
 * Viz notes (dataviz method): categorical palette in FIXED slot order with a
 * validated hue sequence for light and dark; color is assigned to a model id
 * alphabetically (stable per entity, never by rank); >8 models fold into
 * "Other". Stacked segments keep a 2px surface gap; identity is never
 * color-alone (legend labels + tooltips); values wear text tokens.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'

/** Validated categorical palette (dataviz reference instance); slot order is
 * the CVD-safety mechanism — never reorder or cycle. */
const SERIES_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
const SERIES_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']
const OTHER_LIGHT = '#767672'
const OTHER_DARK = '#8f8e89'

interface ModelSpend {
  model: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

interface UsageResponse {
  summary: { dayUsd: number; monthUsd: number; perModel: ModelSpend[] }
  orgBudget: { dailyLimitEur: number | null; monthlyLimitEur: number | null; explicit: boolean }
  status: { blocked: boolean; blockedScope: string | null }
  eurPerUsd: number
}

interface PolicyDto {
  id: string
  scope: 'organization' | 'member' | 'project'
  subjectId: string | null
  dailyLimit: string | null
  monthlyLimit: string | null
}

interface MemberDto {
  id: string
  email: string
  name: string | null
}

interface ProjectDto {
  id: string
  name: string
}

const eur = (value: number): string => `€${value.toFixed(2)}`

interface Segment {
  key: string
  label: string
  colorVar: string
  valueEur: number
  events: number
  monthEur: number
  monthEvents: number
}

/**
 * Stable slot assignment: alphabetical by model id, so an entity keeps its
 * color across windows and filters; models beyond the 8 slots fold into Other.
 */
function buildSegments(perModel: ModelSpend[], eurPerUsd: number, window: 'day' | 'month'): Segment[] {
  const sorted = [...perModel].sort((a, b) => a.model.localeCompare(b.model))
  const segments: Segment[] = []
  let other: Segment | null = null
  sorted.forEach((entry, index) => {
    const valueUsd = window === 'day' ? entry.dayUsd : entry.monthUsd
    const events = window === 'day' ? entry.dayEvents : entry.monthEvents
    const base = {
      valueEur: valueUsd * eurPerUsd,
      events,
      monthEur: entry.monthUsd * eurPerUsd,
      monthEvents: entry.monthEvents,
    }
    if (index < SERIES_LIGHT.length) {
      segments.push({ key: entry.model, label: entry.model, colorVar: `var(--grid-series-${index + 1})`, ...base })
    } else if (other) {
      other.valueEur += base.valueEur
      other.events += base.events
      other.monthEur += base.monthEur
      other.monthEvents += base.monthEvents
    } else {
      other = { key: '__other__', label: '', colorVar: 'var(--grid-series-other)', ...base }
    }
  })
  if (other) segments.push(other)
  return segments.filter((segment) => segment.valueEur > 0)
}

const BudgetMeter: FC<{
  title: string
  segments: Segment[]
  totalEur: number
  limitEur: number | null
  requestsLabel: (count: number) => string
  monthLabel: string
}> = ({ title, segments, totalEur, limitEur, requestsLabel, monthLabel }) => {
  const t = useTranslations('organization')
  const scaleEur = limitEur !== null ? Math.max(limitEur, totalEur) : totalEur
  const over = limitEur !== null && totalEur >= limitEur

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {limitEur !== null
            ? t('budgets.ofLimit', { spent: eur(totalEur), limit: eur(limitEur) })
            : t('budgets.noLimit', { spent: eur(totalEur) })}
        </p>
      </div>
      <div
        className="mt-1.5 flex h-3 w-full overflow-hidden rounded-[4px] bg-muted"
        role="img"
        aria-label={`${title}: ${eur(totalEur)}${limitEur !== null ? ` / ${eur(limitEur)}` : ''}`}
      >
        {scaleEur > 0 &&
          segments.map((segment) => (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                <div
                  className="h-full min-w-[3px] cursor-default border-r-2 border-background last:border-r-0"
                  style={{
                    width: `${(segment.valueEur / scaleEur) * 100}%`,
                    backgroundColor: segment.colorVar,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{segment.label || t('budgets.otherModels')}</p>
                <p>
                  {title}: {eur(segment.valueEur)} · {requestsLabel(segment.events)}
                </p>
                <p>
                  {monthLabel}: {eur(segment.monthEur)} · {requestsLabel(segment.monthEvents)}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}
      </div>
      {over && (
        <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="size-3" aria-hidden />
          {t('budgets.overLimit')}
        </p>
      )}
    </div>
  )
}

const LoadingSkeleton: FC = () => (
  <div className="flex flex-col gap-5">
    {[0, 1].map((i) => (
      <div key={i}>
        <div className="flex justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="mt-2 h-3 w-full" />
      </div>
    ))}
    <Skeleton className="h-16 w-full" />
  </div>
)

export const BudgetUsageCard: FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const t = useTranslations('organization')
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [policies, setPolicies] = useState<PolicyDto[]>([])
  const [members, setMembers] = useState<MemberDto[]>([])
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [loading, setLoading] = useState(true)

  const [dailyLimit, setDailyLimit] = useState('')
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [savingLimits, setSavingLimits] = useState(false)

  const [scopedScope, setScopedScope] = useState<'member' | 'project'>('member')
  const [scopedSubject, setScopedSubject] = useState('')
  const [scopedDaily, setScopedDaily] = useState('')
  const [scopedMonthly, setScopedMonthly] = useState('')
  const [savingScoped, setSavingScoped] = useState(false)

  const load = useCallback(async () => {
    try {
      const [usageRes, budgetsRes] = await Promise.all([
        fetch('/api/organization/usage'),
        fetch('/api/organization/budgets'),
      ])
      if (!usageRes.ok || !budgetsRes.ok) throw new Error('load failed')
      const usageBody = (await usageRes.json()) as UsageResponse
      const budgetsBody = (await budgetsRes.json()) as {
        organization: { dailyLimitEur: number | null; monthlyLimitEur: number | null }
        policies?: PolicyDto[]
      }
      setUsage(usageBody)
      setPolicies((budgetsBody.policies ?? []).filter((policy) => policy.scope !== 'organization'))
      setDailyLimit(budgetsBody.organization.dailyLimitEur?.toString() ?? '')
      setMonthlyLimit(budgetsBody.organization.monthlyLimitEur?.toString() ?? '')
    } catch {
      toast.error(t('budgets.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  // Pickers (admin only): the member directory and org projects, best-effort.
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/organization/members')
      .then(async (res) => (res.ok ? ((await res.json()) as { members: MemberDto[] }).members : []))
      .then(setMembers)
      .catch(() => setMembers([]))
    fetch('/api/projects')
      .then(async (res) => (res.ok ? ((await res.json()) as ProjectDto[]) : []))
      .then((rows) => setProjects(rows.map((row) => ({ id: row.id, name: row.name }))))
      .catch(() => setProjects([]))
  }, [isAdmin])

  const daySegments = useMemo(
    () => (usage ? buildSegments(usage.summary.perModel, usage.eurPerUsd, 'day') : []),
    [usage],
  )
  const monthSegments = useMemo(
    () => (usage ? buildSegments(usage.summary.perModel, usage.eurPerUsd, 'month') : []),
    [usage],
  )

  const memberLabel = useCallback(
    (subjectId: string | null): string => {
      const member = members.find((m) => m.id === subjectId)
      if (!member) return subjectId ?? `(${t('budgets.subjectGone')})`
      return member.name ? `${member.name} (${member.email})` : member.email
    },
    [members, t],
  )

  const projectLabel = useCallback(
    (subjectId: string | null): string =>
      projects.find((p) => p.id === subjectId)?.name ?? subjectId ?? `(${t('budgets.subjectGone')})`,
    [projects, t],
  )

  const parseLimit = (value: string): number | null => {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number.parseFloat(trimmed.replace(',', '.'))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  const saveOrgLimits = useCallback(async () => {
    setSavingLimits(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'organization',
          dailyLimitEur: parseLimit(dailyLimit),
          monthlyLimitEur: parseLimit(monthlyLimit),
        }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? t('budgets.limitsSaveError'))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('budgets.limitsSaved'))
      await load()
    } catch {
      toast.error(t('budgets.limitsSaveError'))
    } finally {
      setSavingLimits(false)
    }
  }, [dailyLimit, monthlyLimit, t, load])

  const saveScopedPolicy = useCallback(async () => {
    setSavingScoped(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: scopedScope,
          subjectId: scopedSubject,
          dailyLimitEur: parseLimit(scopedDaily),
          monthlyLimitEur: parseLimit(scopedMonthly),
        }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? t('budgets.policySaveError'))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('budgets.policySaved'))
      setScopedSubject('')
      setScopedDaily('')
      setScopedMonthly('')
      await load()
    } catch {
      toast.error(t('budgets.policySaveError'))
    } finally {
      setSavingScoped(false)
    }
  }, [scopedScope, scopedSubject, scopedDaily, scopedMonthly, t, load])

  const removePolicy = useCallback(
    async (policy: PolicyDto) => {
      try {
        const res = await fetch('/api/organization/budgets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: policy.scope, subjectId: policy.subjectId }),
        })
        if (!res.ok) throw new Error(String(res.status))
        toast.success(t('budgets.policyRemoved'))
        await load()
      } catch {
        toast.error(t('budgets.policyRemoveError'))
      }
    },
    [t, load],
  )

  if (loading || !usage) {
    return <LoadingSkeleton />
  }

  const requestsLabel = (count: number): string => t('budgets.tooltipRequests', { count })
  const subjectOptions = scopedScope === 'member' ? members : projects

  return (
    <TooltipProvider delayDuration={100}>
      {/* Validated categorical palette — light default, dark steps under `.dark`. */}
      <style>{`
        .grid-usage-viz {
          ${SERIES_LIGHT.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n          ')}
          --grid-series-other: ${OTHER_LIGHT};
        }
        .dark .grid-usage-viz {
          ${SERIES_DARK.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n          ')}
          --grid-series-other: ${OTHER_DARK};
        }
      `}</style>
      <div className="grid-usage-viz flex flex-col gap-5">
        {usage.status.blocked && (
          <Badge variant="destructive" className="self-start">
            <AlertTriangle className="mr-1 size-3" aria-hidden />
            {t('budgets.overLimit')}
          </Badge>
        )}

        <BudgetMeter
          title={t('budgets.today')}
          segments={daySegments}
          totalEur={usage.summary.dayUsd * usage.eurPerUsd}
          limitEur={usage.orgBudget.dailyLimitEur}
          requestsLabel={requestsLabel}
          monthLabel={t('budgets.thisMonth')}
        />
        <BudgetMeter
          title={t('budgets.thisMonth')}
          segments={monthSegments}
          totalEur={usage.summary.monthUsd * usage.eurPerUsd}
          limitEur={usage.orgBudget.monthlyLimitEur}
          requestsLabel={requestsLabel}
          monthLabel={t('budgets.thisMonth')}
        />

        {/* Legend — identity is never color-alone; each entry is hoverable. */}
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">{t('budgets.legendTitle')}</p>
          {monthSegments.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{t('budgets.legendEmpty')}</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {monthSegments.map((segment) => (
                <li key={segment.key}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex cursor-default items-center gap-1.5 text-sm">
                        <span
                          className="inline-block size-2.5 rounded-[2px]"
                          style={{ backgroundColor: segment.colorVar }}
                          aria-hidden
                        />
                        <span className="max-w-56 truncate font-mono text-xs">
                          {segment.label || t('budgets.otherModels')}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">{eur(segment.monthEur)}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{segment.label || t('budgets.otherModels')}</p>
                      <p>
                        {t('budgets.thisMonth')}: {eur(segment.monthEur)} · {requestsLabel(segment.monthEvents)}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isAdmin && (
          <>
            <Separator />
            <div>
              <p className="text-sm font-medium">{t('budgets.limitsTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('budgets.limitsDescription')}</p>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="budget-daily">{t('budgets.dailyLimit')}</Label>
                  <Input
                    id="budget-daily"
                    className="w-36"
                    inputMode="decimal"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="budget-monthly">{t('budgets.monthlyLimit')}</Label>
                  <Input
                    id="budget-monthly"
                    className="w-36"
                    inputMode="decimal"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </div>
                <Button onClick={saveOrgLimits} disabled={savingLimits}>
                  {t('budgets.saveLimits')}
                </Button>
              </div>
            </div>

            <Separator />
            <div>
              <p className="text-sm font-medium">{t('budgets.scopedTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('budgets.scopedDescription')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select
                  value={scopedScope}
                  onValueChange={(v) => {
                    setScopedScope(v as 'member' | 'project')
                    setScopedSubject('')
                  }}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t('budgets.scopeMember')}</SelectItem>
                    <SelectItem value="project">{t('budgets.scopeProject')}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={scopedSubject || undefined} onValueChange={setScopedSubject}>
                  <SelectTrigger className="w-64">
                    <SelectValue
                      placeholder={scopedScope === 'member' ? t('budgets.selectMember') : t('budgets.selectProject')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {subjectOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {'email' in option
                          ? option.name
                            ? `${option.name} (${option.email})`
                            : option.email
                          : option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="w-32"
                  inputMode="decimal"
                  value={scopedDaily}
                  onChange={(e) => setScopedDaily(e.target.value)}
                  placeholder={t('budgets.dailyLimit')}
                  aria-label={t('budgets.dailyLimit')}
                />
                <Input
                  className="w-32"
                  inputMode="decimal"
                  value={scopedMonthly}
                  onChange={(e) => setScopedMonthly(e.target.value)}
                  placeholder={t('budgets.monthlyLimit')}
                  aria-label={t('budgets.monthlyLimit')}
                />
                <Button onClick={saveScopedPolicy} disabled={savingScoped || !scopedSubject}>
                  {t('budgets.addPolicy')}
                </Button>
              </div>

              <div className="mt-4">
                <p className="text-xs font-medium uppercase text-muted-foreground">{t('budgets.activePolicies')}</p>
                {policies.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">{t('budgets.noPolicies')}</p>
                ) : (
                  <ul className="mt-1.5 flex flex-col divide-y rounded-lg border">
                    {policies.map((policy) => (
                      <li key={policy.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                        <Badge variant="outline" className="shrink-0">
                          {policy.scope === 'member' ? t('budgets.scopeMember') : t('budgets.scopeProject')}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate">
                          {policy.scope === 'member' ? memberLabel(policy.subjectId) : projectLabel(policy.subjectId)}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {policy.dailyLimit !== null
                            ? `${eur(Number.parseFloat(policy.dailyLimit))}/${t('budgets.perDay')}`
                            : '—'}
                          {' · '}
                          {policy.monthlyLimit !== null
                            ? `${eur(Number.parseFloat(policy.monthlyLimit))}/${t('budgets.perMonth')}`
                            : '—'}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t('budgets.removePolicy')}
                          aria-label={`${t('budgets.removePolicy')}: ${policy.subjectId}`}
                          onClick={() => removePolicy(policy)}
                        >
                          <Trash2 className="size-3.5 text-muted-foreground" aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
