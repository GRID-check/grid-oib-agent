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
 *  - Zero data retention. Every organization is ZDR unless it opted out, so a
 *    default must have a ZDR endpoint that serves its group: the picker lists
 *    only such models and the save refuses anything else. A default already
 *    saved can still lose its last ZDR endpoint upstream; the row then warns
 *    that every ZDR organization inheriting it has that group's requests
 *    refused until the default changes.
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
import { Check, ChevronDown, Lock, RotateCcw, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemTitle,
} from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatTokens, formatUsd } from '@/lib/format'
import {
  isReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/lib/reasoning-settings/catalog'
import { describeRejections, isZdrListUnavailableResponse } from '@/lib/model-config/rejections'
import { cn } from '@/lib/utils'

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
  /** Live ZDR status of each group's workflow YAML model; null when unknown. */
  workflowDefaultsZdrSafe?: Record<string, boolean | null>
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

/** Which halves of the draft a reload replaces with the server's state. */
interface LoadOptions {
  resetModels: boolean
  resetEfforts: boolean
}

/** Sentinel for "no platform level — follow the workflow config". */
const INHERIT = 'inherit'

const modelDraftOf = (body: PayloadDto): Record<string, string> =>
  Object.fromEntries(Object.entries(body.defaults).map(([group, value]) => [group, value.model]))

const effortDraftOf = (body: EffortPayloadDto): Record<string, ReasoningEffort> =>
  Object.fromEntries(
    Object.entries(body.efforts)
      .filter(([, value]) => isReasoningEffort(value.effort))
      .map(([group, value]) => [group, value.effort as ReasoningEffort])
  )

const ModelPicker: FC<{
  groupId: string
  current: string | null
  onPick: (modelId: string) => void
}> = ({ groupId, current, onPick }) => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelDto[] | null>(null)
  const [zdrUnavailable, setZdrUnavailable] = useState(false)
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
      fetch(
        `/api/platform/model-defaults/models?group=${encodeURIComponent(groupId)}&q=${encodeURIComponent(q)}`
      )
        .then(async (res) => {
          if (!res.ok) {
            const zdrDown = await isZdrListUnavailableResponse(res)
            if (id !== requestId.current) return
            setModels(null)
            setZdrUnavailable(zdrDown)
            return
          }
          const body = (await res.json()) as { models: ModelDto[] }
          if (id === requestId.current) setModels(body.models)
        })
        .catch(() => {
          if (id !== requestId.current) return
          setModels(null)
          setZdrUnavailable(false)
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false)
        })
    },
    [groupId]
  )

  useEffect(() => {
    search('')
    searchInputRef.current?.focus()
  }, [search])

  // Clear the pending debounce on unmount — the popover closes as soon as a
  // model is picked, and a late timer would search against a dead component.
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current)
    },
    []
  )

  const onQueryChange = (value: string): void => {
    setQuery(value)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => search(value), 300)
  }

  /** USD per million tokens, from the catalog's per-token price. */
  const perMillion = (perToken: number): string => formatUsd(perToken * 1_000_000, locale)

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
      <ScrollArea className="max-h-64">
        {loading && <Spinner className="mx-auto my-6" label={t('models.searching')} />}
        {!loading && models === null && (
          <p className="text-destructive px-2 py-4 text-sm" role="alert">
            {zdrUnavailable ? t('models.zdrListUnavailable') : t('models.loadError')}
          </p>
        )}
        {/* The server lists only models with a ZDR endpoint for this group. */}
        {!loading && models?.length === 0 && (
          <p className="text-muted-foreground px-2 py-4 text-sm">{t('models.noZdrResults')}</p>
        )}
        {!loading && models && models.length > 0 && (
          <ItemList role="listbox" aria-label={t('models.pickerLabel')}>
            {models.map((model) => {
              const selected = model.id === current
              return (
                <Item
                  key={model.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={selected}
                  className="cursor-pointer"
                  onClick={() => onPick(model.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onPick(model.id)
                    }
                  }}
                >
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs">{model.id}</ItemTitle>
                    <ItemDescription className="tabular-nums">
                      {t('models.modelMeta', {
                        context: formatTokens(model.contextLength, locale),
                        input: perMillion(model.promptPrice),
                        output: perMillion(model.completionPrice),
                      })}
                    </ItemDescription>
                  </ItemContent>
                  {selected ? (
                    <ItemActions>
                      <Check className="size-4" aria-hidden />
                    </ItemActions>
                  ) : null}
                </Item>
              )
            })}
          </ItemList>
        )}
      </ScrollArea>
    </div>
  )
}

export const PlatformModelDefaults: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  // Rejection reasons share one vocabulary with the organization surface.
  const to = useTranslations('organization')
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [payload, setPayload] = useState<PayloadDto | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [effortPayload, setEffortPayload] = useState<EffortPayloadDto | null>(null)
  const [effortDraft, setEffortDraft] = useState<Record<string, ReasoningEffort>>({})
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickerGroup, setPickerGroup] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // Set once the first load landed: every later load is a refresh that keeps
  // the rows on screen instead of collapsing them into skeletons.
  const loaded = useRef(false)

  const load = useCallback(
    async (
      { resetModels, resetEfforts }: LoadOptions = { resetModels: true, resetEfforts: true }
    ) => {
      const first = !loaded.current
      if (first) setLoading(true)
      else setRefreshing(true)
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
        // Only the halves that landed are replaced by the server's state. A
        // draft whose save failed stays on screen, so the owner can fix the
        // rejected pick and save again instead of re-entering every change.
        if (resetModels) setDraft(modelDraftOf(body))
        if (resetEfforts) setEffortDraft(effortDraftOf(effortBody))
        loaded.current = true
      } catch {
        // A failed refresh keeps what is on screen; only a first load with
        // nothing to show becomes the error state.
        if (first) setError(true)
        else toast.error(t('models.loadError'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [t]
  )

  useEffect(() => {
    void load()
  }, [load])

  const saved = useMemo(
    () => Object.fromEntries(Object.entries(payload?.defaults ?? {}).map(([g, v]) => [g, v.model])),
    [payload]
  )
  // Compared per key, not via JSON.stringify: `draft` is rebuilt by delete +
  // spread, so resetting a group and re-picking the model it already had
  // reorders the keys. Stringifying would call that dirty and let Save fire a
  // real PUT — and a fleet-wide audit event — for a no-op.
  const savedEfforts = useMemo(
    () => (effortPayload ? effortDraftOf(effortPayload) : {}),
    [effortPayload]
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
        const body = (await res.json()) as { details?: unknown }
        const labelOf = (groupId: string): string =>
          payload?.agentGroups.find((group) => group.id === groupId)?.label ?? groupId
        return `${t('models.saveError')} ${describeRejections(body.details, to, labelOf).join(' ')}`.trim()
      }
      if (await isZdrListUnavailableResponse(res)) return t('models.zdrListUnavailable')
      if (!res.ok) throw new Error(String(res.status))
      return null
    } catch {
      return t('models.saveError')
    }
  }, [dirty, draft, note, t, to, payload])

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
      if (modelError) toast.error(modelError)
      else if (effortError) toast.error(effortError)
      else toast.success(t('models.saved'))
      // A rejected model save changed nothing on the server, so there is
      // nothing to re-read and the whole draft (and the note) stays put.
      if (modelError) return
      setNote('')
      await load({ resetModels: true, resetEfforts: !effortError })
    } finally {
      setSaving(false)
    }
  }, [saveModels, saveEfforts, t, load])

  const groups = payload?.agentGroups ?? []

  /** The thinking level a group inherits, named the way the select names levels. */
  const inheritLabel = (fallback: string | null): string => {
    if (!fallback) return t('models.effortInherit')
    const level = isReasoningEffort(fallback) ? t(`models.levels.${fallback}.label`) : fallback
    return t('models.effortInheritWith', { level })
  }

  return (
    <SectionCard
      title={t('models.title')}
      loading={loading}
      refreshing={refreshing}
      skeletonRows={7}
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

      {!canManage ? (
        <Alert className="mb-4">
          <Lock aria-hidden />
          <AlertDescription>{t('models.readOnly')}</AlertDescription>
        </Alert>
      ) : null}

      {/* Column labels only where the columns exist; below `md` each control
          carries its own label instead. */}
      <div
        className="hidden gap-4 border-b pb-2 md:grid md:grid-cols-[minmax(0,1fr)_16rem_12rem]"
        aria-hidden
      >
        <SectionLabel>{t('models.columnGroup')}</SectionLabel>
        <SectionLabel>{t('models.columnModel')}</SectionLabel>
        <SectionLabel>{t('models.columnEffort')}</SectionLabel>
      </div>

      <ul className="flex flex-col divide-y">
        {groups.map((group) => {
          const pinned = draft[group.id]
          const fallback = payload?.workflowDefaults?.[group.id] ?? null
          // The saved state's ZDR verdict, checked live by the server: the pinned
          // default's, or the workflow model's when nothing is pinned.
          const savedModel = saved[group.id]
          const zdrSafe = savedModel
            ? (payload?.defaults?.[group.id]?.zdrSafe ?? null)
            : (payload?.workflowDefaultsZdrSafe?.[group.id] ?? null)
          const showsSaved = (pinned ?? null) === (savedModel ?? null)
          const pinnedEffort = effortDraft[group.id]
          const effortFallback = effortPayload?.workflowEfforts?.[group.id] ?? null
          const changed = !showsSaved || (pinnedEffort ?? null) !== (savedEfforts[group.id] ?? null)
          const shownModel = pinned ?? fallback ?? t('models.unknownFallback')
          const modelLabelId = `model-label-${group.id}`
          const effortLabelId = `effort-label-${group.id}`
          return (
            <li
              key={group.id}
              className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_16rem_12rem] md:items-start md:gap-4"
              data-testid={`model-row-${group.id}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{group.label}</p>
                  {changed ? (
                    <Badge variant="warning" className="font-normal">
                      {t('models.changedBadge')}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {group.description}
                </p>
                {showsSaved && zdrSafe === false && (
                  <p
                    className="text-warning mt-1.5 flex items-start gap-1.5 text-xs"
                    data-testid={`zdr-warning-${group.id}`}
                  >
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {t('models.zdrWarning')}
                  </p>
                )}
                {showsSaved && zdrSafe === null && Boolean(pinned ?? fallback) && (
                  <p className="text-muted-foreground mt-1.5 flex items-start gap-1.5 text-xs">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {t('models.zdrUnknown')}
                  </p>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <SectionLabel id={modelLabelId} className="md:sr-only">
                  {t('models.columnModel')}
                </SectionLabel>
                {canManage ? (
                  <Popover
                    open={pickerGroup === group.id}
                    onOpenChange={(open) => setPickerGroup(open ? group.id : null)}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-between font-mono font-normal"
                        aria-label={t('models.changeFor', {
                          group: group.label,
                          model: shownModel,
                        })}
                        title={shownModel}
                      >
                        <span className="min-w-0 truncate">{shownModel}</span>
                        <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-auto p-3">
                      <ModelPicker
                        groupId={group.id}
                        current={pinned ?? fallback}
                        onPick={(modelId) => {
                          setDraft((prev) => ({ ...prev, [group.id]: modelId }))
                          setPickerGroup(null)
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                ) : (
                  <p
                    className="truncate py-1.5 font-mono text-xs"
                    title={shownModel}
                    aria-labelledby={modelLabelId}
                  >
                    {shownModel}
                  </p>
                )}
                <div className="flex min-h-6 items-center gap-1">
                  <span
                    className={cn('text-xs', pinned ? 'text-foreground' : 'text-muted-foreground')}
                  >
                    {pinned ? t('models.pinnedBadge') : t('models.yamlBadge')}
                  </span>
                  {pinned && canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2"
                      aria-label={`${t('models.clear')}: ${group.label}`}
                      title={t('models.clear')}
                      onClick={() =>
                        setDraft((prev) => {
                          const next = { ...prev }
                          delete next[group.id]
                          return next
                        })
                      }
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      {t('models.reset')}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <SectionLabel id={effortLabelId} className="md:sr-only">
                  {t('models.columnEffort')}
                </SectionLabel>
                <Select
                  value={pinnedEffort ?? INHERIT}
                  disabled={!canManage}
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
                    className="w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"
                    aria-label={t('models.effortSelectLabel', { group: group.label })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>{inheritLabel(effortFallback)}</SelectItem>
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

      {canManage && (dirty || effortDirty) ? (
        <div
          className="mt-2 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end"
          data-testid="model-save-bar"
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="platform-model-defaults-note">{t('models.note')}</FieldLabel>
            <Input
              id="platform-model-defaults-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('models.notePlaceholder')}
              maxLength={500}
            />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(saved)
                setEffortDraft(savedEfforts)
              }}
              disabled={saving}
            >
              {t('models.discard')}
            </Button>
            <Button onClick={() => setConfirmOpen(true)} loading={saving}>
              {t('models.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  )
}
