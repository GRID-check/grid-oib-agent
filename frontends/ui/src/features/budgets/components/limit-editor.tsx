'use client'

/**
 * Setting a scoped LLM limit (ADR-0015): the popover the organization's budget
 * card opens per member and per project, and the one a project's own usage
 * section opens for itself. One editor, so the rule about what a blank field
 * means is written once.
 */

import { type FC, type ReactNode, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLocale, useTranslations } from '@/i18n'
import { parseDecimalInput } from '@/lib/text/parse-decimal'

/** A budget policy as `/api/organization/budgets` sends it. Limits are decimal strings. */
export interface PolicyDto {
  id: string
  scope: 'organization' | 'member' | 'project'
  subjectId: string | null
  dailyLimit: string | null
  monthlyLimit: string | null
}

/**
 * A limit field: blank is "no limit", a non-negative number is the limit, and
 * anything else is invalid.
 *
 * This used to be one function returning `null` for both blank and garbage,
 * and `null` is what the route stores as NO LIMIT: an admin who typed "fünf"
 * or "-5" into the daily limit silently removed it. Invalid now blocks Save.
 */
export type LimitInput = { ok: true; value: number | null } | { ok: false }

export const readLimit = (value: string, locale: string): LimitInput => {
  const parsed = parseDecimalInput(value, locale)
  if (parsed.status === 'blank') return { ok: true, value: null }
  if (parsed.status === 'valid' && parsed.value >= 0) return { ok: true, value: parsed.value }
  return { ok: false }
}

/** Popover editor for one subject's daily/monthly limit (used per member row
 * and for existing project policies). */
export const LimitEditor: FC<{
  scope: 'member' | 'project'
  subjectId: string
  /** The subject's limit today, or undefined when it has none (Remove is then hidden). */
  current: Pick<PolicyDto, 'dailyLimit' | 'monthlyLimit'> | undefined
  /** The unit word for the field labels ("credits" / "tokens"). */
  unitWord: string
  onSaved: () => Promise<void>
  trigger: ReactNode
}> = ({ scope, subjectId, current, unitWord, onSaved, trigger }) => {
  const t = useTranslations('organization')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
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

  const dailyInput = readLimit(daily, locale)
  const monthlyInput = readLimit(monthly, locale)
  const limitsValid = dailyInput.ok && monthlyInput.ok

  const save = async (): Promise<void> => {
    if (!dailyInput.ok || !monthlyInput.ok) return
    setBusy(true)
    try {
      const res = await fetch('/api/organization/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          subjectId,
          dailyLimit: dailyInput.value,
          monthlyLimit: monthlyInput.value,
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
            <FieldLabel htmlFor={`limit-daily-${subjectId}`}>
              {t('budgets.dailyLimit', { unit: unitWord })}
            </FieldLabel>
            <Input
              id={`limit-daily-${subjectId}`}
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
              aria-invalid={!dailyInput.ok || undefined}
            />
            {!dailyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor={`limit-monthly-${subjectId}`}>
              {t('budgets.monthlyLimit', { unit: unitWord })}
            </FieldLabel>
            <Input
              id={`limit-monthly-${subjectId}`}
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
              aria-invalid={!monthlyInput.ok || undefined}
            />
            {!monthlyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" onClick={save} disabled={busy || !limitsValid}>
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
