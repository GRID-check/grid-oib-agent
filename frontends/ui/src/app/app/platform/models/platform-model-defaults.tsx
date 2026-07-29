'use client'

/**
 * Platform → models: the default model every organization inherits.
 *
 * The default a group runs on used to be a literal in the workflow YAML, so
 * moving the fleet to a newer model meant a commit and a backend redeploy. Here
 * it is one save: pick a model per agent group, and every tenant that has not
 * chosen its own model for that group follows on its next turn.
 *
 * Two things this surface owes the person using it, because both are invisible
 * otherwise:
 *
 *  - What a group falls back to when no default is pinned (the YAML model), so
 *    "reset" names a concrete thing instead of an abstraction.
 *  - Which choices Zero-Data-Retention tenants cannot inherit. Those orgs pin
 *    every request to a ZDR endpoint; a default without one leaves them on
 *    their own model, and that is worth knowing before saving, not after.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RotateCcw, Search, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'

interface AgentGroupDto {
  id: string
  label: string
  description: string
}

interface ModelDto {
  id: string
  name: string
  contextLength: number
  promptPrice: number
  completionPrice: number
  zdrSafe: boolean | null
}

interface DefaultDto {
  model: string
  updatedByEmail: string | null
  updatedAt: string
  zdrSafe: boolean | null
}

interface PayloadDto {
  agentGroups: AgentGroupDto[]
  defaults: Record<string, DefaultDto>
  workflowDefaults: Record<string, string | null>
}

const formatContext = (tokens: number): string =>
  tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens)

/** USD per million tokens, from the catalog's per-token price. */
const perMillion = (perToken: number): string => `$${(perToken * 1_000_000).toFixed(2)}`

const ModelPicker: FC<{ groupId: string; onPick: (modelId: string) => void }> = ({ groupId, onPick }) => {
  const t = useTranslations('platform')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelDto[] | null>(null)
  const [loading, setLoading] = useState(true)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback(
    (q: string) => {
      setLoading(true)
      fetch(`/api/platform/model-defaults/models?group=${encodeURIComponent(groupId)}&q=${encodeURIComponent(q)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { models: ModelDto[] }
          setModels(body.models)
        })
        .catch(() => setModels(null))
        .finally(() => setLoading(false))
    },
    [groupId],
  )

  useEffect(() => {
    search('')
  }, [search])

  // Clear the pending debounce on unmount — the popover closes as soon as a
  // model is picked, and a late timer would search against a dead component.
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current)
  }, [])

  const onQueryChange = (value: string): void => {
    setQuery(value)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => search(value), 300)
  }

  return (
    <div className="flex w-80 max-w-[calc(100vw-3rem)] flex-col">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input
          autoFocus
          className="pl-8"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          aria-label={t('models.searchPlaceholder')}
        />
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto" role="listbox">
        {loading && <Spinner className="mx-auto my-6" />}
        {!loading && models === null && <p className="px-2 py-4 text-sm text-destructive">{t('models.loadError')}</p>}
        {!loading && models?.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t('models.noResults')}</p>
        )}
        {!loading &&
          models?.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected="false"
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => onPick(model.id)}
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate font-mono text-sm">{model.id}</span>
                {model.zdrSafe === false && (
                  <ShieldAlert className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('models.noZdr')} />
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('models.contextWindow')} {formatContext(model.contextLength)} · {perMillion(model.promptPrice)} in ·{' '}
                {perMillion(model.completionPrice)} out / M tokens
              </span>
            </button>
          ))}
      </div>
    </div>
  )
}

export const PlatformModelDefaults: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickerGroup, setPickerGroup] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/model-defaults')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PayloadDto
      setPayload(body)
      setDraft(Object.fromEntries(Object.entries(body.defaults).map(([group, value]) => [group, value.model])))
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
    () => Object.fromEntries(Object.entries(payload?.defaults ?? {}).map(([g, v]) => [g, v.model])),
    [payload],
  )
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const defaults = Object.fromEntries(Object.entries(draft).map(([g, model]) => [g, { model }]))
      const res = await fetch('/api/platform/model-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: Record<string, string> }
        toast.error(`${t('models.saveError')} ${Object.values(body.details ?? {}).join('; ')}`)
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('models.saved'))
      setNote('')
      await load()
    } catch {
      toast.error(t('models.saveError'))
    } finally {
      setSaving(false)
    }
  }, [draft, note, t, load])

  const groups = payload?.agentGroups ?? []

  return (
    <SectionCard
      title={t('models.title')}
      description={t('models.description')}
      loading={loading}
      skeletonRows={5}
      error={error}
      errorMessage={t('models.loadError')}
      onRetry={() => void load()}
      testId="platform-model-defaults"
    >
      {/* A save re-points every organization that has not chosen its own model
          — name that before it happens, not in a toast afterwards. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('models.confirmTitle')}
        description={t('models.confirmDescription')}
        confirmLabel={t('models.confirmSave')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        onConfirm={handleSave}
      />

      <ul className="flex flex-col divide-y">
        {groups.map((group) => {
          const pinned = draft[group.id]
          const fallback = payload?.workflowDefaults?.[group.id] ?? null
          const zdrSafe = payload?.defaults?.[group.id]?.zdrSafe ?? null
          return (
            <li
              key={group.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4"
            >
              <div className="min-w-0 sm:flex-1">
                <p className="text-sm font-medium">{group.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
                {pinned && pinned === saved[group.id] && zdrSafe === false && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                    {t('models.zdrWarning')}
                  </p>
                )}
              </div>
              <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0">
                {pinned ? (
                  <Badge variant="secondary" className="font-normal">
                    {t('models.pinnedBadge')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {t('models.yamlBadge')}
                  </Badge>
                )}
                <code
                  className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs sm:max-w-56 sm:flex-none"
                  title={pinned ?? fallback ?? undefined}
                >
                  {pinned ?? fallback ?? t('models.unknownFallback')}
                </code>
                {pinned && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('models.clear')}
                    aria-label={`${t('models.clear')}: ${group.label}`}
                    onClick={() =>
                      setDraft((prev) => {
                        const next = { ...prev }
                        delete next[group.id]
                        return next
                      })
                    }
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                  </Button>
                )}
                <Popover
                  open={pickerGroup === group.id}
                  onOpenChange={(open) => setPickerGroup(open ? group.id : null)}
                >
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      {t('models.change')}
                      <ChevronDown className="ml-1 size-3.5" aria-hidden />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-3">
                    <ModelPicker
                      groupId={group.id}
                      onPick={(modelId) => {
                        setDraft((prev) => ({ ...prev, [group.id]: modelId }))
                        setPickerGroup(null)
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </li>
          )
        })}
      </ul>

      {dirty && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{t('models.unsavedChanges')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="platform-model-defaults-note">{t('models.note')}</Label>
            <Input
              id="platform-model-defaults-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('models.notePlaceholder')}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button className="w-full sm:w-auto" onClick={() => setConfirmOpen(true)} disabled={saving}>
              {saving ? t('models.saving') : t('models.save')}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setDraft(saved)} disabled={saving}>
              {t('models.discard')}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
