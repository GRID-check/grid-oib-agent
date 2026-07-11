'use client'

/**
 * Usage & budgets (ADR-0015): per-model LLM spend as stacked budget meters
 * (today / this month) with a hoverable color-coded legend, a member table
 * combining each member's spend with their optional individual cap (inline
 * editor), org limits, and project limits.
 *
 * Mobile-first: rows/forms stack under the `sm` breakpoint, stats carry their
 * own micro-labels (no table header to lose), and controls go full-width.
 *
 * Viz notes (dataviz method): categorical palette in FIXED slot order with a
 * validated hue sequence for light and dark; color is assigned to a model id
 * alphabetically (stable per entity, never by rank); >8 models fold into
 * "Other". Stacked segments keep a 2px surface gap; identity is never
 * color-alone (legend labels + tooltips); values wear text tokens.
 */

import { type FC, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale, useTranslations } from '@/i18n'
import { formatEur as eur } from '@/lib/format'
import { SeriesPaletteStyle, SERIES_SLOT_COUNT } from '@/components/charts/palette'
import { SpendTrendChart, type SpendTrendPoint } from '@/components/charts/spend-trend-chart'

interface ModelSpend {
  model: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

interface MemberSpend {
  userId: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

interface UsageResponse {
  summary: { dayUsd: number; monthUsd: number; perModel: ModelSpend[] }
  perMember: MemberSpend[] | null
  orgBudget: { dailyLimitEur: number | null; monthlyLimitEur: number | null; explicit: boolean }
  status: { blocked: boolean; blockedScope: string | null }
  eurPerUsd: number
  /** 30-day daily series — present for budget admins only. */
  dailyTrend?: SpendTrendPoint[] | null
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

const parseLimit = (value: string): number | null => {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number.parseFloat(trimmed.replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const policyLimitLabel = (
  policy: PolicyDto,
  perDay: string,
  perMonth: string,
  locale?: string,
): string => {
  const parts: string[] = []
  if (policy.dailyLimit !== null)
    parts.push(`${eur(Number.parseFloat(policy.dailyLimit), locale)}/${perDay}`)
  if (policy.monthlyLimit !== null)
    parts.push(`${eur(Number.parseFloat(policy.monthlyLimit), locale)}/${perMonth}`)
  return parts.join(' · ') || '—'
}

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
    if (index < SERIES_SLOT_COUNT) {
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
  const { locale } = useLocale()
  const scaleEur = limitEur !== null ? Math.max(limitEur, totalEur) : totalEur
  const over = limitEur !== null && totalEur >= limitEur

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-right text-xs tabular-nums text-muted-foreground">
          {limitEur !== null
            ? t('budgets.ofLimit', { spent: eur(totalEur, locale), limit: eur(limitEur, locale) })
            : t('budgets.noLimit', { spent: eur(totalEur, locale) })}
        </p>
      </div>
      <div
        className="mt-1.5 flex h-3 w-full overflow-hidden rounded-[4px] bg-muted"
        role="img"
        aria-label={`${title}: ${eur(totalEur, locale)}${limitEur !== null ? ` / ${eur(limitEur, locale)}` : ''}`}
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
                  {title}: {eur(segment.valueEur, locale)} · {requestsLabel(segment.events)}
                </p>
                <p>
                  {monthLabel}: {eur(segment.monthEur, locale)} · {requestsLabel(segment.monthEvents)}
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

/** Right-aligned mini stat with its own micro-label — table headers can't get
 * lost when rows stack on mobile. */
const Stat: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex min-w-14 flex-col items-end">
    <span className="text-[10px] font-medium uppercase leading-4 text-muted-foreground">{label}</span>
    <span className="text-sm tabular-nums">{children}</span>
  </div>
)

/** Popover editor for one subject's daily/monthly limit (used per member row
 * and for existing project policies). */
const LimitEditor: FC<{
  scope: 'member' | 'project'
  subjectId: string
  current: PolicyDto | undefined
  onSaved: () => Promise<void>
  trigger: ReactNode
}> = ({ scope, subjectId, current, onSaved, trigger }) => {
  const t = useTranslations('organization')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDaily(current?.dailyLimit !== null && current !== undefined ? Number.parseFloat(current.dailyLimit).toString() : '')
      setMonthly(
        current?.monthlyLimit !== null && current !== undefined ? Number.parseFloat(current.monthlyLimit).toString() : '',
      )
    }
  }, [open, current])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          subjectId,
          dailyLimitEur: parseLimit(daily),
          monthlyLimitEur: parseLimit(monthly),
        }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? t('budgets.policySaveError'))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('budgets.policySaved'))
      setOpen(false)
      await onSaved()
    } catch {
      toast.error(t('budgets.policySaveError'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, subjectId }),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('budgets.policyRemoved'))
      setOpen(false)
      await onSaved()
    } catch {
      toast.error(t('budgets.policyRemoveError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`limit-daily-${subjectId}`}>{t('budgets.dailyLimit')}</Label>
            <Input
              id={`limit-daily-${subjectId}`}
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`limit-monthly-${subjectId}`}>{t('budgets.monthlyLimit')}</Label>
            <Input
              id={`limit-monthly-${subjectId}`}
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" onClick={save} disabled={busy}>
              {tCommon('actions.save')}
            </Button>
            {current && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
                <Trash2 className="mr-1 size-3.5" aria-hidden />
                {t('budgets.removePolicy')}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
    <Skeleton className="h-24 w-full" />
  </div>
)

export const BudgetUsageCard: FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [policies, setPolicies] = useState<PolicyDto[]>([])
  const [members, setMembers] = useState<MemberDto[]>([])
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [loading, setLoading] = useState(true)

  const [dailyLimit, setDailyLimit] = useState('')
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [savingLimits, setSavingLimits] = useState(false)
  const [selectedProject, setSelectedProject] = useState('')

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

  /** Directory ∪ ledger: members with spend sorted first, then the rest. */
  const memberRows = useMemo(() => {
    const spendByUser = new Map((usage?.perMember ?? []).map((entry) => [entry.userId, entry]))
    const known = new Set(members.map((member) => member.id))
    const rows = members.map((member) => ({ member, spend: spendByUser.get(member.id) ?? null }))
    for (const entry of usage?.perMember ?? []) {
      if (!known.has(entry.userId)) {
        rows.push({ member: { id: entry.userId, email: entry.userId, name: null }, spend: entry })
      }
    }
    return rows.sort((a, b) => (b.spend?.monthUsd ?? 0) - (a.spend?.monthUsd ?? 0))
  }, [members, usage])

  const memberPolicies = useMemo(
    () => new Map(policies.filter((p) => p.scope === 'member').map((p) => [p.subjectId, p])),
    [policies],
  )
  const projectPolicies = useMemo(() => policies.filter((p) => p.scope === 'project'), [policies])

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

  if (loading || !usage) {
    return <LoadingSkeleton />
  }

  const requestsLabel = (count: number): string => t('budgets.tooltipRequests', { count })
  const projectName = (id: string | null): string =>
    projects.find((p) => p.id === id)?.name ?? id ?? `(${t('budgets.subjectGone')})`

  return (
    <TooltipProvider delayDuration={100}>
      {/* Validated categorical palette — light default, dark steps under `.dark`. */}
      <SeriesPaletteStyle />
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

        {/* 30-day trend (budget admins get the series from the API). */}
        {usage.dailyTrend && usage.dailyTrend.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">{t('budgets.trendTitle')}</p>
            <div className="mt-1.5">
              <SpendTrendChart
                points={usage.dailyTrend}
                eurPerUsd={usage.eurPerUsd}
                requestsLabel={requestsLabel}
                emptyLabel={t('budgets.trendEmpty')}
              />
            </div>
          </div>
        )}

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
                          className="inline-block size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: segment.colorVar }}
                          aria-hidden
                        />
                        <span className="max-w-40 truncate font-mono text-xs sm:max-w-56">
                          {segment.label || t('budgets.otherModels')}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">{eur(segment.monthEur, locale)}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{segment.label || t('budgets.otherModels')}</p>
                      <p>
                        {t('budgets.thisMonth')}: {eur(segment.monthEur, locale)} · {requestsLabel(segment.monthEvents)}
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
            {/* Organization limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.limitsTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('budgets.limitsDescription')}</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1.5 sm:max-w-40">
                  <Label htmlFor="budget-daily">{t('budgets.dailyLimit')}</Label>
                  <Input
                    id="budget-daily"
                    inputMode="decimal"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5 sm:max-w-40">
                  <Label htmlFor="budget-monthly">{t('budgets.monthlyLimit')}</Label>
                  <Input
                    id="budget-monthly"
                    inputMode="decimal"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </div>
                <Button className="w-full sm:w-auto" onClick={saveOrgLimits} disabled={savingLimits}>
                  {t('budgets.saveLimits')}
                </Button>
              </div>
            </div>

            <Separator />
            {/* Member usage & limits table */}
            <div>
              <p className="text-sm font-medium">{t('budgets.membersTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('budgets.membersDescription')}</p>
              <ul className="mt-3 flex flex-col divide-y rounded-lg border">
                {memberRows.map(({ member, spend }) => {
                  const policy = memberPolicies.get(member.id)
                  return (
                    <li
                      key={member.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
                    >
                      <div className="min-w-0 flex-1 basis-full sm:basis-0">
                        <p className="truncate text-sm">{member.name ?? member.email}</p>
                        {member.name && <p className="truncate text-xs text-muted-foreground">{member.email}</p>}
                      </div>
                      <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                        <Stat label={t('budgets.today')}>
                          {spend ? eur(spend.dayUsd * usage.eurPerUsd, locale) : '—'}
                        </Stat>
                        <Stat label={t('budgets.thisMonth')}>
                          {spend ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">{eur(spend.monthUsd * usage.eurPerUsd, locale)}</span>
                              </TooltipTrigger>
                              <TooltipContent>{requestsLabel(spend.monthEvents)}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Stat>
                        <Stat label={t('budgets.limitLabel')}>
                          {policy ? (
                            policyLimitLabel(policy, t('budgets.perDay'), t('budgets.perMonth'), locale)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Stat>
                        <LimitEditor
                          scope="member"
                          subjectId={member.id}
                          current={policy}
                          onSaved={load}
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              title={t('budgets.setLimit')}
                              aria-label={`${t('budgets.setLimit')}: ${member.email}`}
                            >
                              <Pencil className="size-3.5 text-muted-foreground" aria-hidden />
                            </Button>
                          }
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>

            <Separator />
            {/* Project limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.scopedTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('budgets.scopedDescription')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={selectedProject || undefined} onValueChange={setSelectedProject}>
                  <SelectTrigger className="w-full sm:w-72">
                    <SelectValue placeholder={t('budgets.selectProject')} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProject && (
                  <LimitEditor
                    scope="project"
                    subjectId={selectedProject}
                    current={projectPolicies.find((p) => p.subjectId === selectedProject)}
                    onSaved={load}
                    trigger={
                      <Button variant="outline" className="w-full sm:w-auto">
                        {t('budgets.setLimit')}
                      </Button>
                    }
                  />
                )}
              </div>
              {projectPolicies.length > 0 && (
                <ul className="mt-3 flex flex-col divide-y rounded-lg border">
                  {projectPolicies.map((policy) => (
                    <li key={policy.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-sm">{projectName(policy.subjectId)}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {policyLimitLabel(policy, t('budgets.perDay'), t('budgets.perMonth'), locale)}
                      </span>
                      <LimitEditor
                        scope="project"
                        subjectId={policy.subjectId as string}
                        current={policy}
                        onSaved={load}
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('budgets.setLimit')}
                            aria-label={`${t('budgets.setLimit')}: ${projectName(policy.subjectId)}`}
                          >
                            <Pencil className="size-3.5 text-muted-foreground" aria-hidden />
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
