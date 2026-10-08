'use client'

/**
 * Platform → overview → one organization's allowance.
 *
 * Read by everyone who reaches the directory; written only with
 * `platform:organizations:manage`. The server reports `canManage` per request,
 * and the shell's permission context says the same thing before the request
 * lands, so the two are combined: either one saying no hides the write path.
 *
 * Each limit is read by `parseDecimalInput`. Blank is unlimited and the hint
 * says so; anything that is not a number is a field error and Save stays off.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatCredits, formatTokens } from '@/lib/format'
import { fetchPlatformOrgBudget, PlatformBudgetRequestError } from '@/lib/budgets/platform-client'
import { platformOrgBudgetPutSchema, type PlatformOrgBudget } from '@/lib/budgets/platform-contract'
import { formatDecimalInput, parseDecimalInput } from '@/lib/text/parse-decimal'

type LimitDraft =
  { ok: true; value: number | null } | { ok: false; message: 'invalid' | 'ambiguous' }

/** Blank is unlimited; a number must also pass the wire schema's range. */
const readLimit = (raw: string, locale: string): LimitDraft => {
  const parsed = parseDecimalInput(raw, locale)
  if (parsed.status === 'blank') return { ok: true, value: null }
  if (parsed.status === 'invalid')
    return { ok: false, message: parsed.reason === 'ambiguous' ? 'ambiguous' : 'invalid' }
  const inRange = platformOrgBudgetPutSchema.shape.dailyLimit.safeParse(parsed.value).success
  return inRange ? { ok: true, value: parsed.value } : { ok: false, message: 'invalid' }
}

export function PlatformOrgBudgetDialog({
  organization,
  onClose,
}: {
  organization: { id: string; name: string }
  onClose: () => void
}): JSX.Element {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const mayManage = usePlatformCan(PLATFORM_PERMISSIONS.organizationsManage)
  const [budget, setBudget] = useState<PlatformOrgBudget | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    let cancelled = false
    setError(false)
    fetchPlatformOrgBudget(organization.id)
      .then((result) => {
        if (cancelled) return
        setBudget(result)
        setDaily(formatDecimalInput(result.dailyLimit, locale))
        setMonthly(formatDecimalInput(result.monthlyLimit, locale))
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [organization.id, retry, locale])

  const canManage = Boolean(budget?.canManage) && mayManage
  const dailyDraft = readLimit(daily, locale)
  const monthlyDraft = readLimit(monthly, locale)
  const draft =
    budget && dailyDraft.ok && monthlyDraft.ok
      ? platformOrgBudgetPutSchema.safeParse({
          unit: budget.unit,
          dailyLimit: dailyDraft.value,
          monthlyLimit: monthlyDraft.value,
          note: note.trim() || null,
        })
      : null
  const valid = draft?.success === true
  const dirty =
    budget !== null &&
    (!budget.explicit ||
      (dailyDraft.ok && dailyDraft.value !== budget.dailyLimit) ||
      (monthlyDraft.ok && monthlyDraft.value !== budget.monthlyLimit) ||
      note.trim() !== '')

  const save = async (): Promise<void> => {
    if (!draft?.success || !canManage) return
    setSaving(true)
    try {
      await fetchPlatformOrgBudget(organization.id, draft.data)
      toast.success(t('orgBudgets.saved'))
      onClose()
    } catch (error) {
      toast.error(
        t(
          error instanceof PlatformBudgetRequestError && error.status === 409
            ? 'orgBudgets.unitChanged'
            : 'orgBudgets.saveError'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const unitLabel = t(budget?.unit === 'token' ? 'orgBudgets.tokens' : 'orgBudgets.credits')
  const formatAmount = (amount: number): string =>
    budget?.unit === 'token' ? formatTokens(amount, locale) : formatCredits(amount, locale)
  const problem = (limit: LimitDraft): string | null =>
    limit.ok
      ? null
      : limit.message === 'ambiguous'
        ? t('numberField.ambiguous')
        : t('orgBudgets.invalid')

  const limitField = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void
  ): JSX.Element => {
    const message = problem(readLimit(value, locale))
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className="tabular-nums"
          value={value}
          placeholder={t('pricing.unlimitedPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
          disabled={saving}
          readOnly={!canManage}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-error org-budget-hint` : 'org-budget-hint'}
        />
        {message ? <FieldError id={`${id}-error`}>{message}</FieldError> : null}
      </Field>
    )
  }

  const body = (): JSX.Element => {
    if (error) {
      return (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none">{t('orgBudgets.loadError')}</AlertTitle>
          <AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setRetry((value) => value + 1)}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )
    }
    if (!budget) {
      return (
        <div className="flex flex-col gap-4" aria-hidden>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t('orgBudgets.usedToday')}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">
              {formatAmount(budget.dayUsed)} {unitLabel}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t('orgBudgets.usedMonth')}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">
              {formatAmount(budget.monthUsed)} {unitLabel}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-4">
          {limitField(
            'org-budget-monthly',
            t('orgBudgets.monthly', { unit: unitLabel }),
            monthly,
            setMonthly
          )}
          {limitField(
            'org-budget-daily',
            t('orgBudgets.daily', { unit: unitLabel }),
            daily,
            setDaily
          )}
          <FieldDescription id="org-budget-hint">{t('orgBudgets.limitHint')}</FieldDescription>
        </div>
        {canManage ? (
          <Field>
            <FieldLabel htmlFor="org-budget-note">{t('orgBudgets.note')}</FieldLabel>
            <Input
              id="org-budget-note"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              disabled={saving}
            />
          </Field>
        ) : (
          <p className="text-muted-foreground text-sm">{t('orgBudgets.readOnly')}</p>
        )}
      </div>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{t('orgBudgets.title', { name: organization.name })}</DialogTitle>
            {budget ? (
              <Badge variant={budget.explicit ? 'secondary' : 'outline'}>
                {t(budget.explicit ? 'orgBudgets.explicit' : 'orgBudgets.default')}
              </Badge>
            ) : null}
          </div>
          <DialogDescription>{t('orgBudgets.description')}</DialogDescription>
        </DialogHeader>
        {body()}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {canManage ? tc('actions.cancel') : tc('actions.close')}
          </Button>
          {canManage && !error ? (
            <Button onClick={() => void save()} disabled={saving || !valid || !dirty}>
              {tc(saving ? 'states.saving' : 'actions.save')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
