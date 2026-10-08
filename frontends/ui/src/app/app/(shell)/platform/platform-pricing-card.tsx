'use client'

/**
 * Platform → overview: the price list (ADR-0053).
 *
 * Two numbers turn what OpenRouter charges into what a tenant sees, and both
 * live here because they are one decision: the margin multiplier (price ÷
 * cost) and the credit price (USD of price per credit). With them sits the
 * allowance every organization is seeded with until its admins set their own
 * limits — a plan size is a platform decision, not a code constant.
 *
 * A save applies to the NEXT generation recorded, fleet-wide. Nothing on the
 * ledger is repriced: what a tenant was shown last month stays what it was.
 * That is also why the card shows the last few versions — the trail is the
 * answer to "since when has it been 2.5×".
 *
 * Until a platform owner saves once, the deployment runs on the boot floor
 * (margin 1, one credit = one US cent) and the card says so, rather than
 * presenting a decision nobody made as if someone had.
 *
 * Every field is read by `parseDecimalInput`, and a field that is not a number
 * is an error that blocks Save. It used to be read by `parseFloat`, which took
 * "2.5x" as 2.5 and "ten" as NaN, and NaN became `null`: on an allowance, `null`
 * is UNLIMITED, so a typo saved "no limit" for every new organization. Blank is
 * still unlimited on the two allowances, and the fields say so.
 */

import type { JSX } from 'react'
import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupText } from '@/components/ui/input-group'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatCredits, formatDate, formatUsd } from '@/lib/format'
import { formatDecimalInput, parseDecimalInput } from '@/lib/text/parse-decimal'
import { cn } from '@/lib/utils'

interface PricingVersionDto {
  id: string
  marginMultiplier: number
  usdPerCredit: number
  defaultOrgDailyCredits: number | null
  defaultOrgMonthlyCredits: number | null
  note: string | null
  createdByEmail: string | null
  createdAt: string
  status: 'active' | 'superseded'
}

interface PricingDto {
  versionId: string | null
  marginMultiplier: number
  usdPerCredit: number
  defaultOrgDailyCredits: number | null
  defaultOrgMonthlyCredits: number | null
  explicit: boolean
  note: string | null
  updatedByEmail: string | null
  updatedAt: string | null
  history: PricingVersionDto[]
}

type Bounds = { min: number; max: number }

interface BoundsDto {
  marginMultiplier: Bounds
  usdPerCredit: Bounds
  defaultCredits: Bounds
}

interface PayloadDto {
  pricing: PricingDto
  bounds: BoundsDto
}

type FieldKey =
  'marginMultiplier' | 'usdPerCredit' | 'defaultOrgDailyCredits' | 'defaultOrgMonthlyCredits'
type Inputs = Record<FieldKey, string>

const FIELD_KEYS: readonly FieldKey[] = [
  'marginMultiplier',
  'usdPerCredit',
  'defaultOrgDailyCredits',
  'defaultOrgMonthlyCredits',
]

/** A field's problem, as a dictionary key plus its variables. */
interface FieldProblem {
  key:
    | 'numberField.notANumber'
    | 'numberField.ambiguous'
    | 'numberField.required'
    | 'numberField.range'
  vars?: Record<string, string | number>
}

interface Draft {
  values: Record<FieldKey, number | null>
  problems: Partial<Record<FieldKey, FieldProblem>>
}

/** The worked example under the form — a cost every reader can picture. */
const EXAMPLE_COST_USD = 0.04

/** Credit prices go down to $0.0001, so a rate shows four places, not two. */
const RATE_DIGITS = { maximumFractionDigits: 4 }

const boundsFor = (key: FieldKey, bounds: BoundsDto): Bounds =>
  key === 'marginMultiplier'
    ? bounds.marginMultiplier
    : key === 'usdPerCredit'
      ? bounds.usdPerCredit
      : bounds.defaultCredits

/** A bound as the reader writes numbers: "0,0001", "100.000.000". */
const formatBound = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)

const rangeVars = ({ min, max }: Bounds, locale: string): Record<string, string> => ({
  min: formatBound(min, locale),
  max: formatBound(max, locale),
})

/** The two rates are required; blank on an allowance is the explicit "unlimited". */
const isRequired = (key: FieldKey): boolean => key === 'marginMultiplier' || key === 'usdPerCredit'

/** Read every field strictly, against the bounds the server will apply. Pure. */
export function readPricingDraft(inputs: Inputs, bounds: BoundsDto, locale: string): Draft {
  const draft: Draft = {
    values: {
      marginMultiplier: null,
      usdPerCredit: null,
      defaultOrgDailyCredits: null,
      defaultOrgMonthlyCredits: null,
    },
    problems: {},
  }
  for (const key of FIELD_KEYS) {
    const parsed = parseDecimalInput(inputs[key], locale)
    if (parsed.status === 'blank') {
      if (isRequired(key)) draft.problems[key] = { key: 'numberField.required' }
      continue
    }
    if (parsed.status === 'invalid') {
      draft.problems[key] = {
        key: parsed.reason === 'ambiguous' ? 'numberField.ambiguous' : 'numberField.notANumber',
      }
      continue
    }
    const { min, max } = boundsFor(key, bounds)
    if (parsed.value < min || parsed.value > max) {
      draft.problems[key] = { key: 'numberField.range', vars: rangeVars({ min, max }, locale) }
      continue
    }
    draft.values[key] = parsed.value
  }
  return draft
}

const inputsFrom = (pricing: PricingDto, locale: string): Inputs => ({
  marginMultiplier: formatDecimalInput(pricing.marginMultiplier, locale),
  usdPerCredit: formatDecimalInput(pricing.usdPerCredit, locale),
  defaultOrgDailyCredits: formatDecimalInput(pricing.defaultOrgDailyCredits, locale),
  defaultOrgMonthlyCredits: formatDecimalInput(pricing.defaultOrgMonthlyCredits, locale),
})

/** The server's 422 names fields as `marginMultiplier: 0.1–50`; keep the ones we know. */
const fieldsFromServerErrors = (errors: readonly string[]): FieldKey[] =>
  errors
    .map((error) => error.split(':')[0]?.trim())
    .filter((name): name is FieldKey => (FIELD_KEYS as readonly string[]).includes(name ?? ''))

export const PlatformPricingCard: FC<{ onSaved?: () => void }> = ({ onSaved }) => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [inputs, setInputs] = useState<Inputs>({
    marginMultiplier: '',
    usdPerCredit: '',
    defaultOrgDailyCredits: '',
    defaultOrgMonthlyCredits: '',
  })
  const [note, setNote] = useState('')
  /** Fields the server refused on the last save, until they are edited. */
  const [serverRefused, setServerRefused] = useState<ReadonlySet<FieldKey>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/pricing')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PayloadDto
      setPayload(body)
      setInputs(inputsFrom(body.pricing, locale))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [locale])

  useEffect(() => {
    void load()
  }, [load])

  const draft = useMemo(
    () => (payload ? readPricingDraft(inputs, payload.bounds, locale) : null),
    [inputs, payload, locale]
  )
  const valid =
    draft !== null && Object.keys(draft.problems).length === 0 && serverRefused.size === 0
  const saved = useMemo(
    () => (payload ? inputsFrom(payload.pricing, locale) : null),
    [payload, locale]
  )
  const dirty = saved !== null && FIELD_KEYS.some((key) => inputs[key].trim() !== saved[key])

  const setField = (key: FieldKey, value: string): void => {
    setInputs((current) => ({ ...current, [key]: value }))
    setServerRefused((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const handleSave = useCallback(async () => {
    if (!draft || !valid) return
    setSaving(true)
    try {
      const res = await fetch('/api/platform/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft.values, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json().catch(() => null)) as {
          details?: { errors?: string[] }
        } | null
        const errors = body?.details?.errors ?? []
        const refused = fieldsFromServerErrors(errors)
        setServerRefused(new Set(refused))
        // The translated sentence leads; the server's own words are the
        // secondary detail, and only when no field could carry them.
        toast.error(
          t('pricing.saveInvalid'),
          refused.length === 0 && errors.length > 0 ? { description: errors.join('; ') } : undefined
        )
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      // The PUT answers with the new pricing view, so the card updates in place
      // instead of reloading itself into a skeleton under the reader.
      const body = (await res.json()) as { pricing: PricingDto }
      setPayload((current) => (current ? { ...current, pricing: body.pricing } : current))
      setInputs(inputsFrom(body.pricing, locale))
      setNote('')
      toast.success(t('pricing.saved'))
      onSaved?.()
    } catch {
      toast.error(t('pricing.saveError'))
    } finally {
      setSaving(false)
    }
  }, [draft, valid, note, t, locale, onSaved])

  const pricing = payload?.pricing
  const bounds = payload?.bounds

  const problemFor = (key: FieldKey): string | null => {
    const problem = draft?.problems[key]
    if (problem) return t(problem.key, problem.vars)
    if (serverRefused.has(key) && bounds)
      return t('numberField.range', rangeVars(boundsFor(key, bounds), locale))
    return null
  }

  const numberField = (
    key: FieldKey,
    label: string,
    hint: string,
    affix: { start?: string; end?: string }
  ): JSX.Element => {
    const id = `pricing-${key}`
    const problem = problemFor(key)
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {/* `flex-none`: the group is `flex-1` by default, and in a column it grew
            to the height of the taller field beside it. */}
        <InputGroup className="flex-none">
          {affix.start ? (
            <InputGroupAddon>
              <InputGroupText className="text-sm">{affix.start}</InputGroupText>
            </InputGroupAddon>
          ) : null}
          <Input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={inputs[key]}
            onChange={(event) => setField(key, event.target.value)}
            placeholder={isRequired(key) ? undefined : t('pricing.unlimitedPlaceholder')}
            disabled={saving}
            readOnly={!canManage}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-hint${problem ? ` ${id}-error` : ''}`}
            className={cn('tabular-nums', affix.start && 'pl-7', affix.end && 'pr-20')}
          />
          {affix.end ? (
            <InputGroupAddon align="end" className="right-3.5">
              <InputGroupText className="text-sm">{affix.end}</InputGroupText>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {problem ? <FieldError id={`${id}-error`}>{problem}</FieldError> : null}
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      </Field>
    )
  }

  const margin = draft?.values.marginMultiplier ?? null
  const creditPrice = draft?.values.usdPerCredit ?? null
  const exampleCredits =
    margin !== null && creditPrice !== null ? (EXAMPLE_COST_USD * margin) / creditPrice : null
  const creditsUnit = t('orgBudgets.credits')

  const allowance = (value: number | null): string =>
    value === null ? t('pricing.unlimited') : formatCredits(value, locale)

  return (
    <SectionCard
      title={t('pricing.title')}
      description={t('pricing.description')}
      loading={loading && !payload}
      refreshing={loading && payload !== null}
      skeletonRows={4}
      error={error && !payload}
      errorMessage={t('pricing.loadError')}
      onRetry={() => void load()}
      testId="platform-pricing"
      action={
        pricing ? (
          pricing.explicit ? (
            <Badge variant="secondary">{t('pricing.setBadge')}</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              {t('pricing.bootFloorBadge')}
            </Badge>
          )
        ) : undefined
      }
    >
      {/* A price-list change reaches every tenant's next request at once —
          name that before it happens. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('pricing.confirmTitle')}
        description={t('pricing.confirmDescription')}
        confirmLabel={t('pricing.confirmSave')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        onConfirm={handleSave}
      />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
          {numberField(
            'marginMultiplier',
            t('pricing.margin'),
            t(
              'pricing.marginHint',
              rangeVars(bounds?.marginMultiplier ?? { min: 0, max: 0 }, locale)
            ),
            { end: '×' }
          )}
          {numberField('usdPerCredit', t('pricing.usdPerCredit'), t('pricing.usdPerCreditHint'), {
            start: '$',
          })}
          {numberField(
            'defaultOrgDailyCredits',
            t('pricing.defaultDaily'),
            t('pricing.allowanceHint'),
            {
              end: creditsUnit,
            }
          )}
          {numberField(
            'defaultOrgMonthlyCredits',
            t('pricing.defaultMonthly'),
            t('pricing.allowanceHint'),
            {
              end: creditsUnit,
            }
          )}
        </div>

        {/* The worked example: the one sentence that makes two abstract
            numbers concrete, recomputed as the owner types. A note, not an
            alert: it changes on every keystroke and must not be announced. */}
        <Alert role="note" data-testid="pricing-example">
          <Calculator aria-hidden />
          <AlertTitle>{t('pricing.exampleTitle')}</AlertTitle>
          <AlertDescription className="tabular-nums">
            {exampleCredits !== null && margin !== null
              ? t('pricing.example', {
                  cost: formatUsd(EXAMPLE_COST_USD, locale),
                  price: formatUsd(EXAMPLE_COST_USD * margin, locale),
                  credits: exampleCredits,
                  creditsFormatted: formatCredits(exampleCredits, locale),
                })
              : t('pricing.exampleIncomplete')}
          </AlertDescription>
        </Alert>

        {canManage ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel htmlFor="pricing-note">{t('pricing.note')}</FieldLabel>
              <Input
                id="pricing-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('pricing.notePlaceholder')}
                maxLength={500}
                disabled={saving}
              />
            </Field>
            <Button
              className="w-full sm:w-auto"
              onClick={() => setConfirmOpen(true)}
              disabled={saving || !dirty || !valid}
            >
              {saving ? tc('states.saving') : t('pricing.save')}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="pricing-read-only">
            {t('pricing.readOnly')}
          </p>
        )}

        {pricing && pricing.history.length > 0 ? (
          <div className="flex flex-col gap-2">
            <SectionLabel>{t('pricing.historyTitle')}</SectionLabel>
            <div className="@container rounded-lg border">
              <Table data-testid="pricing-history">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('pricing.historyDate')}</TableHead>
                    <TableHead className="text-right">{t('pricing.historyMargin')}</TableHead>
                    <TableHead className="text-right">{t('pricing.historyCredit')}</TableHead>
                    <TableHead className="@lg:table-cell hidden text-right">
                      {t('pricing.historyAllowance')}
                    </TableHead>
                    <TableHead className="@2xl:table-cell hidden">
                      {t('pricing.historyBy')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricing.history.map((version) => (
                    <TableRow key={version.id}>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-2 tabular-nums">
                          {formatDate(version.createdAt, locale)}
                          {version.status === 'active' ? (
                            <Badge variant="secondary">{t('pricing.historyCurrent')}</Badge>
                          ) : null}
                        </span>
                        {/* Narrow: the allowance rides under the date. */}
                        <span className="text-muted-foreground @lg:hidden block whitespace-normal text-xs tabular-nums">
                          {t('pricing.historyAllowance')}:{' '}
                          {allowance(version.defaultOrgDailyCredits)} /{' '}
                          {allowance(version.defaultOrgMonthlyCredits)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDecimalInput(version.marginMultiplier, locale)}×
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsd(version.usdPerCredit, locale, RATE_DIGITS)}
                      </TableCell>
                      <TableCell className="@lg:table-cell hidden whitespace-nowrap text-right tabular-nums">
                        {allowance(version.defaultOrgDailyCredits)} /{' '}
                        {allowance(version.defaultOrgMonthlyCredits)}
                      </TableCell>
                      <TableCell className="@2xl:table-cell hidden max-w-64">
                        <span className="text-muted-foreground block truncate">
                          {version.createdByEmail ?? ''}
                        </span>
                        {version.note ? (
                          <span className="block truncate text-xs">{version.note}</span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}
