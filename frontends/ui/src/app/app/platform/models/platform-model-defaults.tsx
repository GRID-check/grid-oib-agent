'use client'

/**
 * Platform → models: the default model AND thinking level every organization
 * inherits.
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
 *
 * Model and reasoning effort live on ONE row because they are two settings of
 * one decision: together they determine what a turn costs and how good it is,
 * and tuning either blind to the other is how a fleet ends up on an expensive
 * model at a high thinking level. They are persisted through two endpoints
 * (a model change is catalog-validated and an upstream outage can block it; an
 * effort change never is, so turning reasoning spend DOWN always works), and a
 * save that half-succeeds says exactly which half.
 *
 * The effort layer is platform-only — no org override, unlike the model. A
 * tenant choosing its own model is a product feature; a tenant dialling its own
 * reasoning spend is not.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RotateCcw, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemContent, ItemDescription, ItemList, ItemTitle } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/reasoning-settings/catalog'

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

interface EffortDto {
  effort: string
  updatedByEmail: string | null
  updatedAt: string
}

interface EffortPayloadDto {
  efforts: Record<string, EffortDto>
  workflowEfforts: Record<string, string | null>
}

/** Sentinel for "no platform level — follow the workflow config". */
const INHERIT = 'inherit'

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
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Only the newest search may write state: a slow earlier request resolving
  // after a later one would otherwise leave the list showing results for a
  // query the user has already typed past.
  const requestId = useRef(0)

  const search = useCallback(
    (q: string) => {
      setLoading(true)
      const id = ++requestId.current
      fetch(`/api/platform/model-defaults/models?group=${encodeURIComponent(groupId)}&q=${encodeURIComponent(q)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { models: ModelDto[] }
          if (id === requestId.current) setModels(body.models)
        })
        .catch(() => {
          if (id === requestId.current) setModels(null)
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false)
        })
    },
    [groupId],
  )

  useEffect(() => {
    search('')
    searchInputRef.current?.focus()
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
    <div className="flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-2">
      <SearchField
        value={query}
        onChange={onQueryChange}
        placeholder={t('models.searchPlaceholder')}
        label={t('models.searchPlaceholder')}
        type="text"
        inputRef={searchInputRef}
      />
      <ScrollArea className="max-h-64" role="listbox">
        {loading && <Spinner className="mx-auto my-6" />}
        {!loading && models === null && <p className="px-2 py-4 text-sm text-destructive">{t('models.loadError')}</p>}
        {!loading && models?.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t('models.noResults')}</p>
        )}
        {!loading && models && models.length > 0 && (
          <ItemList>
            {models.map((model) => (
              <Item
                key={model.id}
                role="option"
                tabIndex={0}
                aria-selected="false"
                onClick={() => onPick(model.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onPick(model.id)
                  }
                }}
              >
                <ItemContent>
                  <ItemTitle className="flex items-center gap-1.5 font-mono">
                    {model.id}
                    {model.zdrSafe === false && (
                      <ShieldAlert className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('models.noZdr')} />
                    )}
                  </ItemTitle>
                  <ItemDescription>
                    {t('models.contextWindow')} {formatContext(model.contextLength)} · {perMillion(model.promptPrice)} in
                    · {perMillion(model.completionPrice)} out / M tokens
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemList>
        )}
      </ScrollArea>
    </div>
  )
}

export const PlatformModelDefaults: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [effortPayload, setEffortPayload] = useState<EffortPayloadDto | null>(null)
  const [effortDraft, setEffortDraft] = useState<Record<string, ReasoningEffort>>({})
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
      // Two endpoints, one screen: fetched together so the card never renders
      // half its state. Either failing is a load failure — a row that showed a
      // model but no thinking level would read as "no level set".
      const [res, effortRes] = await Promise.all([
        fetch('/api/platform/model-defaults'),
        fetch('/api/platform/reasoning-efforts'),
      ])
      if (!res.ok) throw new Error(String(res.status))
      if (!effortRes.ok) throw new Error(String(effortRes.status))
      const body = (await res.json()) as PayloadDto
      const effortBody = (await effortRes.json()) as EffortPayloadDto
      setPayload(body)
      setEffortPayload(effortBody)
      setDraft(Object.fromEntries(Object.entries(body.defaults).map(([group, value]) => [group, value.model])))
      setEffortDraft(
        Object.fromEntries(
          Object.entries(effortBody.efforts).map(([group, value]) => [
            group,
            value.effort as ReasoningEffort,
          ]),
        ),
      )
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
  // Compared per key, not via JSON.stringify: `draft` is rebuilt by delete +
  // spread, so resetting a group and re-picking the model it already had
  // reorders the keys. Stringifying would call that dirty and let Save fire a
  // real PUT — and a fleet-wide audit event — for a no-op.
  const savedEfforts = useMemo(
    () => Object.fromEntries(Object.entries(effortPayload?.efforts ?? {}).map(([g, v]) => [g, v.effort])),
    [effortPayload],
  )

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(saved)])
    return [...keys].some((key) => draft[key] !== saved[key])
  }, [draft, saved])

  const effortDirty = useMemo(() => {
    const keys = new Set([...Object.keys(effortDraft), ...Object.keys(savedEfforts)])
    return [...keys].some((key) => effortDraft[key] !== savedEfforts[key])
  }, [effortDraft, savedEfforts])

  /** PUT the models half; returns an error string, or null on success/no-op. */
  const saveModels = useCallback(async (): Promise<string | null> => {
    if (!dirty) return null
    const defaults = Object.fromEntries(Object.entries(draft).map(([g, model]) => [g, { model }]))
    try {
      const res = await fetch('/api/platform/model-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults, note: note.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: Record<string, string> }
        return `${t('models.saveError')} ${Object.values(body.details ?? {}).join('; ')}`
      }
      if (!res.ok) throw new Error(String(res.status))
      return null
    } catch {
      return t('models.saveError')
    }
  }, [dirty, draft, note, t])

  /** PUT the thinking-level half; returns an error string, or null. */
  const saveEfforts = useCallback(async (): Promise<string | null> => {
    if (!effortDirty) return null
    try {
      const res = await fetch('/api/platform/reasoning-efforts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ efforts: effortDraft, note: note.trim() || null }),
      })
      if (!res.ok) throw new Error(String(res.status))
      return null
    } catch {
      return t('models.effortSaveError')
    }
  }, [effortDirty, effortDraft, note, t])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // Sequential, models first: the model save is the one an upstream catalog
      // outage can reject, and a rejected model must not leave the fleet on a
      // thinking level chosen for a model that never landed.
      const modelError = await saveModels()
      const effortError = modelError ? null : await saveEfforts()
      // A half-failure is named as such: silently reporting success for the part
      // that worked is how an owner walks away believing both took effect.
      if (modelError && effortError) toast.error(`${modelError} ${effortError}`)
      else if (modelError) toast.error(modelError)
      else if (effortError) toast.error(effortError)
      else toast.success(t('models.saved'))
      if (!modelError) setNote('')
      await load()
    } finally {
      setSaving(false)
    }
  }, [saveModels, saveEfforts, t, load])

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
          const pinnedEffort = effortDraft[group.id]
          const effortFallback = effortPayload?.workflowEfforts?.[group.id] ?? null
          return (
            // Controls on their OWN row, not beside the text: the row carries
            // five of them (state badge, model, reset, picker, thinking level)
            // and competing with the description for one line squeezed the text
            // column to a word per line at the widths this page actually renders
            // at.
            <li key={group.id} className="flex flex-col gap-2 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{group.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
                {pinned && pinned === saved[group.id] && zdrSafe === false && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                    {t('models.zdrWarning')}
                  </p>
                )}
              </div>
              <div className="flex w-full flex-wrap items-center gap-1.5 sm:justify-end">
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
                <Select
                  value={pinnedEffort ?? INHERIT}
                  onValueChange={(value) => {
                    setEffortDraft((prev) => {
                      const next = { ...prev }
                      if (value === INHERIT) delete next[group.id]
                      else next[group.id] = value as ReasoningEffort
                      return next
                    })
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0 sm:w-48"
                    aria-label={t('models.effortSelectLabel', { group: group.label })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {effortFallback
                        ? `${t('models.effortInherit')} (${effortFallback})`
                        : t('models.effortInherit')}
                    </SelectItem>
                    {REASONING_EFFORTS.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {t(`models.levels.${effort}.label`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </li>
          )
        })}
      </ul>

      {(dirty || effortDirty) && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{t('models.unsavedChanges')}</p>
          <Field>
            <FieldLabel htmlFor="platform-model-defaults-note">{t('models.note')}</FieldLabel>
            <Input
              id="platform-model-defaults-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('models.notePlaceholder')}
              maxLength={500}
            />
          </Field>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button className="w-full sm:w-auto" onClick={() => setConfirmOpen(true)} disabled={saving}>
              {saving ? t('models.saving') : t('models.save')}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => {
                setDraft(saved)
                setEffortDraft(savedEfforts as Record<string, ReasoningEffort>)
              }}
              disabled={saving}>
              {t('models.discard')}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
