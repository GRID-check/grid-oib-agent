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
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import { SectionCard } from '@/features/platform/components/section-card'
import { useLocale, useTranslations } from '@/i18n'
import { formatCredits, formatUsd } from '@/lib/format'

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

interface BoundsDto {
  marginMultiplier: { min: number; max: number }
  usdPerCredit: { min: number; max: number }
  defaultCredits: { min: number; max: number }
}

interface PayloadDto {
  pricing: PricingDto
  bounds: BoundsDto
}

/** The worked example under the form — a cost every reader can picture. */
const EXAMPLE_COST_USD = 0.04

const parseNumber = (value: string): number | null => {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number.parseFloat(trimmed.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

const toInput = (value: number | null): string => (value === null ? '' : String(value))

export const PlatformPricingCard: FC<{ onSaved?: () => void }> = ({ onSaved }) => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const [margin, setMargin] = useState('')
  const [usdPerCredit, setUsdPerCredit] = useState('')
  const [dailyCredits, setDailyCredits] = useState('')
  const [monthlyCredits, setMonthlyCredits] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/pricing')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PayloadDto
      setPayload(body)
      setMargin(String(body.pricing.marginMultiplier))
      setUsdPerCredit(String(body.pricing.usdPerCredit))
      setDailyCredits(toInput(body.pricing.defaultOrgDailyCredits))
      setMonthlyCredits(toInput(body.pricing.defaultOrgMonthlyCredits))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const draft = useMemo(
    () => ({
      marginMultiplier: parseNumber(margin),
      usdPerCredit: parseNumber(usdPerCredit),
      defaultOrgDailyCredits: parseNumber(dailyCredits),
      defaultOrgMonthlyCredits: parseNumber(monthlyCredits),
    }),
    [margin, usdPerCredit, dailyCredits, monthlyCredits],
  )

  const dirty = useMemo(() => {
    if (!payload) return false
    const { pricing } = payload
    return (
      draft.marginMultiplier !== pricing.marginMultiplier ||
      draft.usdPerCredit !== pricing.usdPerCredit ||
      draft.defaultOrgDailyCredits !== pricing.defaultOrgDailyCredits ||
      draft.defaultOrgMonthlyCredits !== pricing.defaultOrgMonthlyCredits
    )
  }, [draft, payload])

  /** The two rates are required; the allowances may be blank (= unlimited). */
  const complete = draft.marginMultiplier !== null && draft.usdPerCredit !== null

  /** The worked example, live against the draft so a typo shows before saving. */
  const exampleCredits =
    draft.marginMultiplier !== null && draft.usdPerCredit !== null && draft.usdPerCredit > 0
      ? (EXAMPLE_COST_USD * draft.marginMultiplier) / draft.usdPerCredit
      : null

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/platform/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: { errors?: string[] } }
        toast.error(`${t('pricing.saveError')} ${(body.details?.errors ?? []).join('; ')}`)
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('pricing.saved'))
      setNote('')
      await load()
      onSaved?.()
    } catch {
      toast.error(t('pricing.saveError'))
    } finally {
      setSaving(false)
    }
  }, [draft, note, t, load, onSaved])

  const pricing = payload?.pricing
  const bounds = payload?.bounds

  return (
    <SectionCard
      title={t('pricing.title')}
      description={t('pricing.description')}
      loading={loading}
      skeletonRows={4}
      error={error}
      errorMessage={t('pricing.loadError')}
      onRetry={() => void load()}
      testId="platform-pricing"
      action={
        pricing ? (
          pricing.explicit ? (
            <Badge variant="secondary" className="font-normal">
              {t('pricing.setBadge')}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
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

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="pricing-margin">{t('pricing.margin')}</FieldLabel>
            <Input
              id="pricing-margin"
              inputMode="decimal"
              value={margin}
              onChange={(e) => setMargin(e.target.value)}
              disabled={saving}
              aria-describedby="pricing-margin-hint"
            />
            <p id="pricing-margin-hint" className="text-xs text-muted-foreground">
              {t('pricing.marginHint', { min: bounds?.marginMultiplier.min ?? 0, max: bounds?.marginMultiplier.max ?? 0 })}
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor="pricing-credit">{t('pricing.usdPerCredit')}</FieldLabel>
            <Input
              id="pricing-credit"
              inputMode="decimal"
              value={usdPerCredit}
              onChange={(e) => setUsdPerCredit(e.target.value)}
              disabled={saving}
              aria-describedby="pricing-credit-hint"
            />
            <p id="pricing-credit-hint" className="text-xs text-muted-foreground">
              {t('pricing.usdPerCreditHint')}
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor="pricing-daily">{t('pricing.defaultDaily')}</FieldLabel>
            <Input
              id="pricing-daily"
              inputMode="decimal"
              value={dailyCredits}
              onChange={(e) => setDailyCredits(e.target.value)}
              placeholder={t('pricing.unlimitedPlaceholder')}
              disabled={saving}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pricing-monthly">{t('pricing.defaultMonthly')}</FieldLabel>
            <Input
              id="pricing-monthly"
              inputMode="decimal"
              value={monthlyCredits}
              onChange={(e) => setMonthlyCredits(e.target.value)}
              placeholder={t('pricing.unlimitedPlaceholder')}
              disabled={saving}
            />
          </Field>
        </div>

        {/* The worked example: the one sentence that makes two abstract
            numbers concrete, recomputed as the owner types. */}
        <p className="text-sm text-muted-foreground" data-testid="pricing-example">
          {exampleCredits !== null
            ? t('pricing.example', {
                cost: formatUsd(EXAMPLE_COST_USD, locale),
                price: formatUsd(EXAMPLE_COST_USD * (draft.marginMultiplier ?? 1), locale),
                credits: formatCredits(exampleCredits, locale),
              })
            : t('pricing.exampleIncomplete')}
        </p>

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
            disabled={saving || !dirty || !complete}
          >
            {t('pricing.save')}
          </Button>
        </div>

        {pricing?.explicit && pricing.updatedByEmail && pricing.updatedAt && (
          <p className="text-xs text-muted-foreground">
            {t('pricing.updatedBy', {
              email: pricing.updatedByEmail,
              date: new Date(pricing.updatedAt).toLocaleDateString(locale),
            })}
            {pricing.note ? ` — ${pricing.note}` : ''}
          </p>
        )}

        {pricing && pricing.history.length > 0 && (
          <div>
            <SectionLabel>{t('pricing.historyTitle')}</SectionLabel>
            <ol className="mt-1.5 flex flex-col divide-y text-xs" data-testid="pricing-history">
              {pricing.history.map((version) => (
                <li key={version.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                  <span className="tabular-nums">
                    {t('pricing.historyEntry', {
                      margin: version.marginMultiplier,
                      usdPerCredit: formatUsd(version.usdPerCredit, locale),
                      daily: version.defaultOrgDailyCredits === null ? '∞' : formatCredits(version.defaultOrgDailyCredits, locale),
                      monthly:
                        version.defaultOrgMonthlyCredits === null ? '∞' : formatCredits(version.defaultOrgMonthlyCredits, locale),
                    })}
                    {version.note ? ` — ${version.note}` : ''}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(version.createdAt).toLocaleDateString(locale)}
                    {version.createdByEmail ? ` · ${version.createdByEmail}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </SectionCard>
  )
}
