'use client'

/**
 * Usage & budgets (ADR-0015) — what the organization is spending on LLM calls,
 * and how close that spend is to the limits that will stop it.
 *
 * **Three questions, three forms — chosen before any color was picked.**
 *
 * 1. *Am I about to be cut off?* is a single ratio against a limit, and the
 *    form for a ratio against a limit is a **meter**, not a chart. Two of them
 *    (today, this month) because the two limits are enforced separately and a
 *    reader who is fine on the month can still be blocked by the day.
 * 2. *Where is the money going?* is **part-to-whole** across models, which is a
 *    horizontal stacked bar plus its table twin.
 * 3. *Is this getting worse?* is **change over time**, which is the 30-day
 *    column chart (`SpendTrendChart`) — admins only, because only they are
 *    served the series.
 *
 * **The meter is no longer painted by model, and that is the point.** It used
 * to be a single stacked bar doing both job 1 and job 2 at once: eight
 * categorical hues on a bar whose whole story is one number. Two things broke.
 * The reader could not tell a healthy meter from an exhausted one, because the
 * fill color was carrying model identity and had nothing left to say about
 * state; and the segment for the model that mattered was, at 4% of a 300px
 * bar, twelve pixels of hue with no room for a label. Splitting them lets the
 * meter fill carry *severity* — accent under the limit, the critical status
 * step at or over it — and gives composition its own full-width bar where a
 * small share is still a visible slice.
 *
 * **No number is reachable only by hovering.** The per-model table under the
 * composition bar is always open, not behind a toggle. It is doing three jobs
 * at once: it is the legend (every model named beside its swatch, so identity
 * is never color-alone), it is the table view the method requires, and it is
 * the mandatory relief for the light-mode contrast WARN — three of the eight
 * light slots sit below 3:1 on white, which is legal only when the values are
 * also readable as text. Segments carry hover/focus tooltips on top of that,
 * never instead of it.
 *
 * **No labels inside the segments.** Every segment of a stacked bar except the
 * outermost is an interior segment with no free end to spill into, and a label
 * that does not fit gets clipped rather than shortened. The method's answer is
 * to skip the inline label and let the legend and the table carry it, which is
 * what the table below is for.
 *
 * **Color follows the model, never its rank.** Slots are assigned by sorting
 * model ids alphabetically, so a model keeps its hue when the reader moves
 * between the day and the month numbers and when a new model starts appearing.
 * Letting rank drive the palette would repaint every survivor the moment the
 * set changed. Past the eight documented slots the tail folds into a neutral
 * "Other" — a ninth generated hue is indistinguishable from an existing one
 * under CVD.
 *
 * **The bar stacks in palette order; the table lists in spend order.** These
 * differ on purpose. The palette's colorblind separation is only validated for
 * *adjacent* slots — the pairs that actually touch in a stack — so stacking by
 * size would put arbitrary, unvalidated pairs against each other. Table rows do
 * not touch, so there the useful order is the one that answers "who is biggest".
 * (Filtering out models that spent nothing can still skip a slot and put 2
 * beside 4; the 2px surface gap and the named table rows are what carry that
 * case, which is exactly the secondary encoding the method asks for.)
 *
 * **CSS-box marks, not SVG.** Every mark here is one-dimensional — a fill along
 * a horizontal track. A box gets an exact 4px radius on the data end and an
 * exact 2px surface gap between segments at any container width; the same
 * shapes in a `viewBox` need either measured pixel widths or a non-uniform
 * scale that would smear the corner radii. The 30-day trend, which does have a
 * second dimension, is its own component.
 *
 * The palette itself is not chosen here — it is the token block at the end of
 * `globals.css`, validated for both modes against this app's real card
 * surfaces. See that block for the validator output and the contrast relief
 * rule it obliges.
 *
 * Mobile-first: rows/forms stack under the `sm` breakpoint, stats carry their
 * own micro-labels (no table header to lose), and controls go full-width.
 */

import { type FC, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemList } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale, useTranslations } from '@/i18n'
import { formatEur as eur } from '@/lib/format'
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

/** Documented categorical slots in `globals.css`. The 9th model folds to Other. */
const SPEND_SLOT_COUNT = 8
const OTHER_KEY = '__other__'

/** The one gap width in this card — segment separation is negative space. */
const SEGMENT_GAP_CLASS = 'border-r-2 border-card last:border-r-0'

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
  locale?: string
): string => {
  const parts: string[] = []
  if (policy.dailyLimit !== null)
    parts.push(`${eur(Number.parseFloat(policy.dailyLimit), locale)}/${perDay}`)
  if (policy.monthlyLimit !== null)
    parts.push(`${eur(Number.parseFloat(policy.monthlyLimit), locale)}/${perMonth}`)
  return parts.join(' · ') || '—'
}

/** One model's spend in both windows, already converted to EUR. */
interface ModelSeries {
  key: string
  /** Empty for the folded tail — the renderer supplies the translated label. */
  label: string
  /** 1-based palette slot; the folded tail sorts after every real slot. */
  slot: number
  colorVar: string
  dayEur: number
  dayEvents: number
  monthEur: number
  monthEvents: number
}

/** Palette order — what the bar stacks in, because adjacency is validated. */
const bySlot = (a: ModelSeries, b: ModelSeries): number => a.slot - b.slot
/** Reading order — what the table lists in; rows don't touch, so rank is free. */
const byMonthSpend = (a: ModelSeries, b: ModelSeries): number => {
  if (a.key === OTHER_KEY) return 1
  if (b.key === OTHER_KEY) return -1
  return b.monthEur - a.monthEur
}

/**
 * Slot assignment is alphabetical by model id and happens BEFORE any filtering,
 * so a model that spent nothing today still owns its color for the month bar —
 * the two windows never disagree about what blue means.
 */
function buildModelSeries(perModel: ModelSpend[], eurPerUsd: number): ModelSeries[] {
  const byModelId = [...perModel].sort((a, b) => a.model.localeCompare(b.model))
  const series: ModelSeries[] = []
  const tail = { dayEur: 0, dayEvents: 0, monthEur: 0, monthEvents: 0 }
  let tailCount = 0

  byModelId.forEach((entry, index) => {
    const values = {
      dayEur: entry.dayUsd * eurPerUsd,
      dayEvents: entry.dayEvents,
      monthEur: entry.monthUsd * eurPerUsd,
      monthEvents: entry.monthEvents,
    }
    if (index < SPEND_SLOT_COUNT) {
      series.push({
        key: entry.model,
        label: entry.model,
        slot: index + 1,
        colorVar: `var(--spend-series-${index + 1})`,
        ...values,
      })
      return
    }
    tail.dayEur += values.dayEur
    tail.dayEvents += values.dayEvents
    tail.monthEur += values.monthEur
    tail.monthEvents += values.monthEvents
    tailCount += 1
  })

  if (tailCount > 0) {
    series.push({
      key: OTHER_KEY,
      label: '',
      slot: SPEND_SLOT_COUNT + 1,
      colorVar: 'var(--spend-other)',
      ...tail,
    })
  }

  return series
}

/**
 * Spend against one limit. The track IS the limit, so "how full" is literal
 * rather than a rescaled proportion; once spend passes the limit the track has
 * to grow to hold it, and a tick marks where the limit sat. The tick only ever
 * appears in the over state, where the sentence underneath explains it — an
 * unlabelled reference line is furniture the reader has to guess at.
 */
const BudgetMeter: FC<{
  title: string
  totalEur: number
  limitEur: number | null
}> = ({ title, totalEur, limitEur }) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()
  const over = limitEur !== null && totalEur >= limitEur
  const scaleEur = limitEur !== null ? Math.max(limitEur, totalEur) : totalEur
  const fillPct = scaleEur > 0 ? Math.min((totalEur / scaleEur) * 100, 100) : 0
  const limitPct = over && limitEur !== null && scaleEur > 0 ? (limitEur / scaleEur) * 100 : null
  const reading =
    limitEur !== null
      ? t('budgets.ofLimit', { spent: eur(totalEur, locale), limit: eur(limitEur, locale) })
      : t('budgets.noLimit', { spent: eur(totalEur, locale) })

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {/* The direct label. Every meter states its own value, so the fill
            colour is a redundant cue and never the only carrier of state. */}
        <p className="text-muted-foreground text-right text-xs tabular-nums">{reading}</p>
      </div>
      <div
        className="bg-muted relative mt-1.5 h-2.5 w-full overflow-hidden rounded-[4px]"
        role="img"
        aria-label={`${title}: ${reading}`}
        data-testid={`budget-meter-${over ? 'over' : 'within'}`}
      >
        <div
          className="h-full rounded-r-[4px]"
          style={{
            width: `${fillPct}%`,
            backgroundColor: over ? 'var(--spend-meter-over)' : 'var(--spend-meter)',
          }}
        />
        {limitPct !== null && (
          <span
            className="bg-foreground/60 absolute inset-y-0 w-px"
            style={{ left: `${limitPct}%` }}
            aria-hidden
            data-testid="budget-limit-tick"
          />
        )}
      </div>
      {over && (
        <p className="text-destructive mt-1 flex items-center gap-1 text-xs">
          <AlertTriangle className="size-3" aria-hidden />
          {t('budgets.overLimit')}
        </p>
      )}
    </div>
  )
}

/**
 * Part-to-whole across models for the month. Full width so a 3% model is still
 * a slice you can aim at; 2px of card colour between fills rather than a stroke
 * around them, because a border is ink that isn't data. Hit target is the whole
 * segment including its gap, and the values it shows also live in the table.
 */
const CompositionBar: FC<{
  segments: ModelSeries[]
  totalEur: number
  otherLabel: string
  todayLabel: string
  monthLabel: string
  requestsLabel: (count: number) => string
}> = ({ segments, totalEur, otherLabel, todayLabel, monthLabel, requestsLabel }) => {
  const { locale } = useLocale()
  if (totalEur <= 0 || segments.length === 0) return null

  return (
    <div
      className="bg-muted flex h-3 w-full overflow-hidden rounded-[4px]"
      role="img"
      aria-label={`${monthLabel}: ${eur(totalEur, locale)}`}
      data-testid="spend-composition"
    >
      {segments.map((segment) => (
        <Tooltip key={segment.key}>
          <TooltipTrigger asChild>
            <div
              className={`h-full min-w-[4px] cursor-default ${SEGMENT_GAP_CLASS}`}
              style={{
                width: `${(segment.monthEur / totalEur) * 100}%`,
                backgroundColor: segment.colorVar,
              }}
            />
          </TooltipTrigger>
          <TooltipContent>
            {/* Value leads, series name follows — the reader already has the
                series (they are pointing at it) and wants the number. */}
            <p className="font-medium tabular-nums">
              {eur(segment.monthEur, locale)} · {requestsLabel(segment.monthEvents)}
            </p>
            <p className="text-xs">{segment.label || otherLabel}</p>
            <p className="text-xs tabular-nums">
              {todayLabel}: {eur(segment.dayEur, locale)}
            </p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * The table twin of the composition bar: legend, table view and contrast relief
 * in one object. Values are tabular because they are a column; the swatch beside
 * the name is what carries identity, never coloured text.
 */
const SpendTable: FC<{
  segments: ModelSeries[]
  otherLabel: string
  captionLabel: string
  todayLabel: string
  monthLabel: string
  requestsLabel: (count: number) => string
}> = ({ segments, otherLabel, captionLabel, todayLabel, monthLabel, requestsLabel }) => {
  const { locale } = useLocale()

  return (
    <table className="mt-1.5 w-full border-collapse text-sm" data-testid="spend-table">
      <caption className="sr-only">{captionLabel}</caption>
      <thead>
        <tr className="text-muted-foreground border-b text-[10px] font-medium uppercase leading-4">
          <th scope="col" className="py-1 text-left font-medium">
            <span className="sr-only">{captionLabel}</span>
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {todayLabel}
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {monthLabel}
          </th>
        </tr>
      </thead>
      <tbody>
        {segments.map((segment) => (
          <tr key={segment.key} className="border-b last:border-b-0">
            <th scope="row" className="min-w-0 py-1.5 pr-3 text-left font-normal">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: segment.colorVar }}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block max-w-40 truncate font-mono text-xs sm:max-w-none">
                    {segment.label || otherLabel}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {requestsLabel(segment.monthEvents)}
                  </span>
                </span>
              </span>
            </th>
            <td className="py-1.5 text-right align-top tabular-nums">
              {segment.dayEur > 0 ? (
                eur(segment.dayEur, locale)
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="py-1.5 text-right align-top tabular-nums">
              {eur(segment.monthEur, locale)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Right-aligned mini stat with its own micro-label — table headers can't get
 * lost when rows stack on mobile. */
const Stat: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex min-w-14 flex-col items-end">
    <SectionLabel>{label}</SectionLabel>
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
      setDaily(
        current?.dailyLimit !== null && current !== undefined
          ? Number.parseFloat(current.dailyLimit).toString()
          : ''
      )
      setMonthly(
        current?.monthlyLimit !== null && current !== undefined
          ? Number.parseFloat(current.monthlyLimit).toString()
          : ''
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
          <Field>
            <FieldLabel htmlFor={`limit-daily-${subjectId}`}>{t('budgets.dailyLimit')}</FieldLabel>
            <Input
              id={`limit-daily-${subjectId}`}
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`limit-monthly-${subjectId}`}>{t('budgets.monthlyLimit')}</FieldLabel>
            <Input
              id={`limit-monthly-${subjectId}`}
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
            />
          </Field>
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
  <div className="flex min-h-[16rem] flex-col gap-5">
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

  const modelSeries = useMemo(
    () => (usage ? buildModelSeries(usage.summary.perModel, usage.eurPerUsd) : []),
    [usage]
  )
  /** Only models that actually spent this month can be a slice of it. */
  const monthSeries = useMemo(
    () => modelSeries.filter((series) => series.monthEur > 0),
    [modelSeries]
  )
  /** Stacked in palette order; listed in spend order. See the module note. */
  const monthStack = useMemo(() => [...monthSeries].sort(bySlot), [monthSeries])
  const monthRanked = useMemo(() => [...monthSeries].sort(byMonthSpend), [monthSeries])

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
    [policies]
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
  const monthTotalEur = monthSeries.reduce((sum, series) => sum + series.monthEur, 0)

  return (
    <TooltipProvider delayDuration={100}>
      {/* `grid-spend-viz` scopes the validated chart tokens (end of globals.css). */}
      <div className="grid-spend-viz animate-in fade-in-0 flex min-h-[16rem] flex-col gap-5 duration-200 ease-out motion-reduce:animate-none">
        {usage.status.blocked && (
          <Badge variant="destructive" className="self-start">
            <AlertTriangle className="mr-1 size-3" aria-hidden />
            {t('budgets.overLimit')}
          </Badge>
        )}

        {/* Job 1 — the ratio against each limit. */}
        <BudgetMeter
          title={t('budgets.today')}
          totalEur={usage.summary.dayUsd * usage.eurPerUsd}
          limitEur={usage.orgBudget.dailyLimitEur}
        />
        <BudgetMeter
          title={t('budgets.thisMonth')}
          totalEur={usage.summary.monthUsd * usage.eurPerUsd}
          limitEur={usage.orgBudget.monthlyLimitEur}
        />

        {/* Job 3 — change over time (budget admins get the series from the API). */}
        {usage.dailyTrend && usage.dailyTrend.length > 0 && (
          <div>
            <SectionLabel>{t('budgets.trendTitle')}</SectionLabel>
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

        {/* Job 2 — part-to-whole by model, and its always-open table twin. */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <SectionLabel>{t('budgets.legendTitle')}</SectionLabel>
            {monthSeries.length > 0 && (
              <p className="text-muted-foreground text-xs tabular-nums">
                {eur(monthTotalEur, locale)}
              </p>
            )}
          </div>
          {monthSeries.length === 0 ? (
            <EmptyState variant="bare" title={t('budgets.legendEmpty')} />
          ) : (
            <>
              <div className="mt-1.5">
                <CompositionBar
                  segments={monthStack}
                  totalEur={monthTotalEur}
                  otherLabel={t('budgets.otherModels')}
                  todayLabel={t('budgets.today')}
                  monthLabel={t('budgets.thisMonth')}
                  requestsLabel={requestsLabel}
                />
              </div>
              <SpendTable
                segments={monthRanked}
                otherLabel={t('budgets.otherModels')}
                captionLabel={t('budgets.legendTitle')}
                todayLabel={t('budgets.today')}
                monthLabel={t('budgets.thisMonth')}
                requestsLabel={requestsLabel}
              />
            </>
          )}
        </div>

        {isAdmin && (
          <>
            <Separator />
            {/* Organization limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.limitsTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('budgets.limitsDescription')}
              </p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field className="flex-1 sm:max-w-40">
                  <FieldLabel htmlFor="budget-daily">{t('budgets.dailyLimit')}</FieldLabel>
                  <Input
                    id="budget-daily"
                    inputMode="decimal"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </Field>
                <Field className="flex-1 sm:max-w-40">
                  <FieldLabel htmlFor="budget-monthly">{t('budgets.monthlyLimit')}</FieldLabel>
                  <Input
                    id="budget-monthly"
                    inputMode="decimal"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                    placeholder={t('budgets.noLimitPlaceholder')}
                  />
                </Field>
                <Button
                  className="w-full sm:w-auto"
                  onClick={saveOrgLimits}
                  disabled={savingLimits}
                >
                  {t('budgets.saveLimits')}
                </Button>
              </div>
            </div>

            <Separator />
            {/* Member usage & limits table */}
            <div>
              <p className="text-sm font-medium">{t('budgets.membersTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('budgets.membersDescription')}
              </p>
              <ItemList as="ul" className="mt-3">
                {memberRows.map(({ member, spend }) => {
                  const policy = memberPolicies.get(member.id)
                  return (
                    <Item
                      as="li"
                      key={member.id}
                      className="flex-wrap gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
                    >
                      <div className="min-w-0 flex-1 basis-full sm:basis-0">
                        <p className="truncate text-sm">{member.name ?? member.email}</p>
                        {member.name && (
                          <p className="text-muted-foreground truncate text-xs">{member.email}</p>
                        )}
                      </div>
                      <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                        <Stat label={t('budgets.today')}>
                          {spend ? eur(spend.dayUsd * usage.eurPerUsd, locale) : '—'}
                        </Stat>
                        <Stat label={t('budgets.thisMonth')}>
                          {spend ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">
                                  {eur(spend.monthUsd * usage.eurPerUsd, locale)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{requestsLabel(spend.monthEvents)}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Stat>
                        <Stat label={t('budgets.limitLabel')}>
                          {policy ? (
                            policyLimitLabel(
                              policy,
                              t('budgets.perDay'),
                              t('budgets.perMonth'),
                              locale
                            )
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
                              <Pencil className="text-muted-foreground size-3.5" aria-hidden />
                            </Button>
                          }
                        />
                      </div>
                    </Item>
                  )
                })}
              </ItemList>
            </div>

            <Separator />
            {/* Project limits */}
            <div>
              <p className="text-sm font-medium">{t('budgets.scopedTitle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('budgets.scopedDescription')}
              </p>
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
                <ItemList as="ul" className="mt-3">
                  {projectPolicies.map((policy) => (
                    <Item
                      as="li"
                      key={policy.id}
                      className="flex-wrap gap-x-4 gap-y-1 px-3 py-2.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {projectName(policy.subjectId)}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {policyLimitLabel(
                          policy,
                          t('budgets.perDay'),
                          t('budgets.perMonth'),
                          locale
                        )}
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
                            <Pencil className="text-muted-foreground size-3.5" aria-hidden />
                          </Button>
                        }
                      />
                    </Item>
                  ))}
                </ItemList>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
