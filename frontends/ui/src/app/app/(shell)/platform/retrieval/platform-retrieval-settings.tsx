'use client'

/**
 * Platform → retrieval: how many chunks/results each search fetches.
 *
 * The retrieval counts used to be literals in the workflow YAML or hard-coded
 * tool constants, so tuning recall/context-size trade-offs meant a commit and
 * a backend redeploy. Here it is one save: adjust a count and every
 * organization's searches follow on their next request.
 *
 * A setting left at its boot default is not stored at all — the PUT sends only
 * the pins, and the backend resolves each missing key against its own YAML/
 * constant fallback. That keeps "reset to default" a deletion, not a write of
 * a number that could drift away from the shipped default later.
 *
 * Number fields keep the TEXT the owner typed as their draft. Parsing on every
 * keystroke snapped a cleared field straight back to its default, so "delete
 * the 10, type 25" read as 1025-ish fumbling. The text is validated against
 * the setting's range, an invalid value says why under the field, and Save
 * stays off until every field parses.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Lock, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { isSwitchSetting } from '@/lib/retrieval-settings/catalog'

interface DefinitionDto {
  key: string
  defaultValue: number
  min: number
  max: number
  allowedValues?: number[]
  label: string
  description: string
}

interface SettingDto {
  key: string
  value: number
  defaultValue: number
  overridden: boolean
  updatedByEmail: string | null
  updatedAt: string | null
}

interface PayloadDto {
  definitions: DefinitionDto[]
  settings: SettingDto[]
}

/** The typed text as a whole number in range, or null when it is not one. */
export function parseSettingValue(
  raw: string,
  definition: Pick<DefinitionDto, 'min' | 'max' | 'allowedValues'>
): number | null {
  const text = raw.trim()
  if (!/^-?\d+$/.test(text)) return null
  const value = Number(text)
  if (value < definition.min || value > definition.max) return null
  if (definition.allowedValues && !definition.allowedValues.includes(value)) return null
  return value
}

const draftOf = (body: PayloadDto): Record<string, string> =>
  Object.fromEntries(body.settings.map((setting) => [setting.key, String(setting.value)]))

export const PlatformRetrievalSettings: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const loaded = useRef(false)

  const load = useCallback(async () => {
    const first = !loaded.current
    if (first) setLoading(true)
    else setRefreshing(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/retrieval-settings')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PayloadDto
      setPayload(body)
      setDraft(draftOf(body))
      loaded.current = true
    } catch {
      // A failed refresh keeps the rows; only a first load with nothing to
      // show becomes the error state.
      if (first) setError(true)
      else toast.error(t('retrieval.loadError'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const definitions = useMemo(() => payload?.definitions ?? [], [payload])
  const saved = useMemo(
    () =>
      Object.fromEntries((payload?.settings ?? []).map((setting) => [setting.key, setting.value])),
    [payload]
  )

  /** Each setting's parsed draft; null where the typed text is not valid. */
  const parsed = useMemo(
    () =>
      new Map(
        definitions.map((definition) => [
          definition.key,
          parseSettingValue(draft[definition.key] ?? String(definition.defaultValue), definition),
        ])
      ),
    [definitions, draft]
  )
  const invalid = [...parsed.values()].some((value) => value === null)

  // Compared per key on the parsed value: "07" and "7" are the same setting.
  const dirty = useMemo(
    () =>
      definitions.some(
        (definition) =>
          parsed.get(definition.key) !== (saved[definition.key] ?? definition.defaultValue)
      ),
    [definitions, parsed, saved]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // Whole-set semantics on the server: a key absent from the body is
      // cleared. So a draft value equal to its boot default is omitted — it
      // should ride the shipped default, not pin a copy of it.
      const settings = Object.fromEntries(
        definitions
          .map(
            (definition) =>
              [definition.key, parsed.get(definition.key), definition.defaultValue] as const
          )
          .filter(
            ([, value, defaultValue]) =>
              value !== null && value !== undefined && value !== defaultValue
          )
          .map(([key, value]) => [key, value])
      )
      const res = await fetch('/api/platform/retrieval-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: { errors?: string[] } }
        toast.error(`${t('retrieval.saveError')} ${(body.details?.errors ?? []).join('; ')}`.trim())
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('retrieval.saved'))
      setNote('')
      await load()
    } catch {
      toast.error(t('retrieval.saveError'))
    } finally {
      setSaving(false)
    }
  }, [definitions, parsed, note, t, load])

  const settingsByKey = useMemo(
    () => new Map((payload?.settings ?? []).map((setting) => [setting.key, setting])),
    [payload]
  )

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value)
  const switchWord = (value: number): string =>
    value === 1 ? t('retrieval.on') : t('retrieval.off')
  const disabled = saving || !canManage

  return (
    <SectionCard
      loading={loading}
      refreshing={refreshing}
      skeletonRows={6}
      error={error}
      errorMessage={t('retrieval.loadError')}
      onRetry={() => void load()}
      empty={definitions.length === 0}
      emptyIcon={SlidersHorizontal}
      emptyTitle={t('retrieval.emptyTitle')}
      emptyDescription={t('retrieval.emptyDescription')}
      testId="platform-retrieval-settings"
    >
      {/* Deeper retrieval is a recall/latency/cost trade-off for every
          organization at once — name that before it happens. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('retrieval.confirmTitle')}
        description={t('retrieval.confirmDescription')}
        confirmLabel={t('retrieval.confirmSave')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        onConfirm={handleSave}
      />

      {!canManage ? (
        <Alert className="mb-2">
          <Lock aria-hidden />
          <AlertDescription>{t('retrieval.readOnly')}</AlertDescription>
        </Alert>
      ) : null}

      <ul className="flex flex-col divide-y">
        {definitions.map((definition) => {
          const raw = draft[definition.key] ?? String(definition.defaultValue)
          const value = parsed.get(definition.key) ?? null
          const setting = settingsByKey.get(definition.key)
          const adjusted = value !== null && value !== definition.defaultValue
          const isSwitch = isSwitchSetting(definition)
          const inputId = `retrieval-${definition.key}`
          const hintId = `${inputId}-hint`
          const defaultText = isSwitch
            ? switchWord(definition.defaultValue)
            : number(definition.defaultValue)
          const hint = definition.allowedValues
            ? t('retrieval.defaultHint', { value: defaultText })
            : t('retrieval.rangeDefaultHint', {
                min: number(definition.min),
                max: number(definition.max),
                value: defaultText,
              })
          const setValue = (next: string): void =>
            setDraft((prev) => ({ ...prev, [definition.key]: next }))
          return (
            <li
              key={definition.key}
              className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-start sm:gap-6"
              data-testid={`retrieval-row-${definition.key}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <FieldLabel htmlFor={inputId}>{definition.label}</FieldLabel>
                  {adjusted ? (
                    <Badge variant="secondary" className="font-normal">
                      {t('retrieval.pinnedBadge')}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {definition.description}
                </p>
                {adjusted && setting?.updatedByEmail ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('retrieval.updatedBy', { email: setting.updatedByEmail })}
                  </p>
                ) : null}
              </div>

              <Field className="gap-1">
                <div className="flex items-center gap-2">
                  {isSwitch ? (
                    <Switch
                      id={inputId}
                      disabled={disabled}
                      aria-describedby={hintId}
                      checked={value === 1}
                      onCheckedChange={(on) => setValue(on ? '1' : '0')}
                    />
                  ) : definition.allowedValues ? (
                    <Select disabled={disabled} value={raw} onValueChange={setValue}>
                      <SelectTrigger
                        id={inputId}
                        size="sm"
                        className="w-28 tabular-nums"
                        aria-describedby={hintId}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {definition.allowedValues.map((option) => (
                          <SelectItem key={option} value={String(option)}>
                            {number(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      disabled={disabled}
                      className="h-8 w-28 tabular-nums"
                      aria-describedby={hintId}
                      aria-invalid={value === null || undefined}
                      value={raw}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  )}
                  {adjusted && canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={saving}
                      title={t('retrieval.reset')}
                      aria-label={`${t('retrieval.reset')}: ${definition.label}`}
                      onClick={() => setValue(String(definition.defaultValue))}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      {t('retrieval.resetShort')}
                    </Button>
                  ) : null}
                </div>
                {value === null ? (
                  <FieldError id={hintId}>
                    {t('retrieval.invalidRange', {
                      min: number(definition.min),
                      max: number(definition.max),
                    })}
                  </FieldError>
                ) : (
                  <FieldDescription id={hintId} className="tabular-nums">
                    {hint}
                  </FieldDescription>
                )}
              </Field>
            </li>
          )
        })}
      </ul>

      {canManage && dirty ? (
        <div
          className="mt-2 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end"
          data-testid="retrieval-save-bar"
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="platform-retrieval-settings-note">
              {t('retrieval.note')}
            </FieldLabel>
            <Input
              id="platform-retrieval-settings-note"
              disabled={saving}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('retrieval.notePlaceholder')}
              maxLength={500}
            />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="ghost"
              onClick={() => payload && setDraft(draftOf(payload))}
              disabled={saving}
            >
              {t('retrieval.discard')}
            </Button>
            <Button onClick={() => setConfirmOpen(true)} loading={saving} disabled={invalid}>
              {t('retrieval.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  )
}
