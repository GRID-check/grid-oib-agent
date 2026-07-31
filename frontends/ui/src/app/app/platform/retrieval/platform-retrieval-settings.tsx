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
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'

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

export const PlatformRetrievalSettings: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/retrieval-settings')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PayloadDto
      setPayload(body)
      setDraft(Object.fromEntries(body.settings.map((setting) => [setting.key, setting.value])))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saved = useMemo(
    () => Object.fromEntries((payload?.settings ?? []).map((setting) => [setting.key, setting.value])),
    [payload],
  )
  // Compared per key, not via JSON.stringify: key order is not meaningful.
  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(saved)])
    return [...keys].some((key) => draft[key] !== saved[key])
  }, [draft, saved])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // Whole-set semantics on the server: a key absent from the body is
      // cleared. So a draft value equal to its boot default is omitted — it
      // should ride the shipped default, not pin a copy of it.
      const settings = Object.fromEntries(
        (payload?.definitions ?? [])
          .filter((definition) => draft[definition.key] !== definition.defaultValue)
          .map((definition) => [definition.key, draft[definition.key]]),
      )
      const res = await fetch('/api/platform/retrieval-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: { errors?: string[] } }
        toast.error(`${t('retrieval.saveError')} ${(body.details?.errors ?? []).join('; ')}`)
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
  }, [draft, note, payload, t, load])

  const settingsByKey = useMemo(
    () => new Map((payload?.settings ?? []).map((setting) => [setting.key, setting])),
    [payload],
  )

  return (
    <SectionCard
      title={t('retrieval.title')}
      description={t('retrieval.description')}
      loading={loading}
      skeletonRows={5}
      error={error}
      errorMessage={t('retrieval.loadError')}
      onRetry={() => void load()}
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

      <ul className="flex flex-col divide-y">
        {(payload?.definitions ?? []).map((definition) => {
          const value = draft[definition.key]
          const setting = settingsByKey.get(definition.key)
          const adjusted = value !== undefined && value !== definition.defaultValue
          return (
            <li
              key={definition.key}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4"
            >
              <div className="min-w-0 sm:flex-1">
                <p className="text-sm font-medium">{definition.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{definition.description}</p>
                {adjusted && setting?.updatedByEmail && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('retrieval.updatedBy', { email: setting.updatedByEmail })}
                  </p>
                )}
              </div>
              <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0">
                {adjusted ? (
                  <Badge variant="secondary" className="font-normal">
                    {t('retrieval.pinnedBadge')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {t('retrieval.defaultBadge')}
                  </Badge>
                )}
                {definition.allowedValues ? (
                  <select
                    disabled={saving}
                    className="h-9 w-24 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    aria-label={definition.label}
                    value={value ?? definition.defaultValue}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [definition.key]: Number(event.target.value) }))
                    }
                  >
                    {definition.allowedValues.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type="number"
                    disabled={saving}
                    className="w-24"
                    aria-label={definition.label}
                    min={definition.min}
                    max={definition.max}
                    step={1}
                    value={value ?? definition.defaultValue}
                    title={t('retrieval.rangeHint', { min: definition.min, max: definition.max })}
                    onChange={(event) => {
                      const next = event.target.valueAsNumber
                      setDraft((prev) => ({ ...prev, [definition.key]: Number.isNaN(next) ? definition.defaultValue : next }))
                    }}
                  />
                )}
                {adjusted && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    title={t('retrieval.reset')}
                    aria-label={`${t('retrieval.reset')}: ${definition.label}`}
                    onClick={() => setDraft((prev) => ({ ...prev, [definition.key]: definition.defaultValue }))}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {dirty && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{t('retrieval.unsavedChanges')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="platform-retrieval-settings-note">{t('retrieval.note')}</Label>
            <Input
              id="platform-retrieval-settings-note"
              disabled={saving}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('retrieval.notePlaceholder')}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button className="w-full sm:w-auto" onClick={() => setConfirmOpen(true)} disabled={saving}>
              {saving ? t('retrieval.saving') : t('retrieval.save')}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setDraft(saved)} disabled={saving}>
              {t('retrieval.discard')}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
