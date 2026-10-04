'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatCredits, formatTokens } from '@/lib/format'
import { fetchPlatformOrgBudget, PlatformBudgetRequestError } from '@/lib/budgets/platform-client'
import { platformOrgBudgetPutSchema, type PlatformOrgBudget } from '@/lib/budgets/platform-contract'

const parseLimit = (value: string): number | null =>
  value.trim() === '' ? null : Number(value.trim().replace(',', '.'))

export function PlatformOrgBudgetDialog({
  organization,
  onClose,
}: {
  organization: { id: string; name: string }
  onClose: () => void
}) {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
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
    fetchPlatformOrgBudget(organization.id).then((result) => {
      if (cancelled) return
      setBudget(result)
      setDaily(result.dailyLimit === null ? '' : String(result.dailyLimit))
      setMonthly(result.monthlyLimit === null ? '' : String(result.monthlyLimit))
    }).catch(() => {
      if (!cancelled) setError(true)
    })
    return () => { cancelled = true }
  }, [organization.id, retry])

  const draft = platformOrgBudgetPutSchema.safeParse({
    unit: budget?.unit,
    dailyLimit: parseLimit(daily),
    monthlyLimit: parseLimit(monthly),
    note: note.trim() || null,
  })
  const dirty = budget && (
    !budget.explicit ||
    parseLimit(daily) !== budget.dailyLimit ||
    parseLimit(monthly) !== budget.monthlyLimit ||
    note.trim() !== ''
  )

  const save = async () => {
    if (!draft.success || !budget?.canManage) return
    setSaving(true)
    try {
      await fetchPlatformOrgBudget(organization.id, draft.data)
      toast.success(t('orgBudgets.saved'))
      onClose()
    } catch (error) {
      toast.error(t(error instanceof PlatformBudgetRequestError && error.status === 409
        ? 'orgBudgets.unitChanged'
        : 'orgBudgets.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const unitLabel = t(budget?.unit === 'token' ? 'orgBudgets.tokens' : 'orgBudgets.credits')
  const formatAmount = (amount: number) =>
    budget?.unit === 'token' ? formatTokens(amount, locale) : formatCredits(amount, locale)

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t('orgBudgets.title', { name: organization.name })}</DialogTitle>
          <DialogDescription>{t('orgBudgets.description')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert">
            <p>{t('orgBudgets.loadError')}</p>
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button>
          </div>
        ) : !budget ? <Skeleton className="h-48 w-full" /> : (
          <div className="flex flex-col gap-4">
            <Badge variant="secondary">{t(budget.explicit ? 'orgBudgets.explicit' : 'orgBudgets.default')}</Badge>
            <p className="text-sm">
              {t('orgBudgets.usage', { day: formatAmount(budget.dayUsed), month: formatAmount(budget.monthUsed), unit: unitLabel })}
            </p>
            <Field>
              <FieldLabel htmlFor="org-budget-monthly">{t('orgBudgets.monthly', { unit: unitLabel })}</FieldLabel>
              <Input id="org-budget-monthly" inputMode="decimal" value={monthly}
                onChange={(event) => setMonthly(event.target.value)} disabled={saving || !budget.canManage}
                aria-describedby="org-budget-hint" />
            </Field>
            <Field>
              <FieldLabel htmlFor="org-budget-daily">{t('orgBudgets.daily', { unit: unitLabel })}</FieldLabel>
              <Input id="org-budget-daily" inputMode="decimal" value={daily}
                onChange={(event) => setDaily(event.target.value)} disabled={saving || !budget.canManage}
                aria-describedby="org-budget-hint" />
            </Field>
            <p id="org-budget-hint" className="text-xs text-muted-foreground">{t('orgBudgets.limitHint')}</p>
            {budget.canManage ? (
              <Field>
                <FieldLabel htmlFor="org-budget-note">{t('orgBudgets.note')}</FieldLabel>
                <Input id="org-budget-note" value={note} maxLength={500}
                  onChange={(event) => setNote(event.target.value)} disabled={saving} />
              </Field>
            ) : <p className="text-sm text-muted-foreground">{t('orgBudgets.readOnly')}</p>}
            {!draft.success ? <p role="alert" className="text-sm text-destructive">{t('orgBudgets.invalid')}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{tc('actions.cancel')}</Button>
          {budget?.canManage && !error ? (
            <Button onClick={() => void save()} disabled={saving || !draft.success || !dirty}>
              {tc(saving ? 'states.saving' : 'actions.save')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
