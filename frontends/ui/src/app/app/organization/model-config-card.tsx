'use client'

/**
 * Org-admin editor for runtime model configuration (ADR-0014).
 *
 * Per agent group: the effective model — an override or the actual workflow
 * default (resolved from the backend's loaded YAML) — with a searchable
 * picker (Popover) that only lists models passing the group's capability
 * requirements, and a per-group reset back to the default. Saving creates a
 * new immutable version; the history panel offers one-click rollback.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, History, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'

interface AgentGroupDto {
  id: string
  label: string
  description: string
  requirements: { requiredParameters: string[]; minContextLength: number }
}

interface ModelDto {
  id: string
  name: string
  contextLength: number
  promptPrice: number
  completionPrice: number
}

interface VersionDto {
  id: string
  version: number
  overrides: Record<string, { model: string }>
  comment: string | null
  createdBy: string
  createdAt: string
}

const formatContext = (tokens: number): string =>
  tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens)

/** USD per million tokens, from the catalog's per-token price. */
const perMillion = (perToken: number): string => `$${(perToken * 1_000_000).toFixed(2)}`

const ModelPicker: FC<{
  group: AgentGroupDto
  onPick: (modelId: string) => void
}> = ({ group, onPick }) => {
  const t = useTranslations('organization')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelDto[] | null>(null)
  const [loading, setLoading] = useState(true)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback(
    (q: string) => {
      setLoading(true)
      fetch(`/api/organization/model-config/models?group=${encodeURIComponent(group.id)}&q=${encodeURIComponent(q)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { models: ModelDto[] }
          setModels(body.models)
        })
        .catch(() => setModels(null))
        .finally(() => setLoading(false))
    },
    [group.id],
  )

  useEffect(() => {
    search('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id])

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
        {!loading && models === null && (
          <p className="px-2 py-4 text-sm text-destructive">{t('models.loadError')}</p>
        )}
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
              <span className="truncate font-mono text-sm">{model.id}</span>
              <span className="text-xs text-muted-foreground">
                {t('models.contextWindow')} {formatContext(model.contextLength)} · {perMillion(model.promptPrice)} in
                · {perMillion(model.completionPrice)} out / M tokens
              </span>
            </button>
          ))}
      </div>
    </div>
  )
}

export const ModelConfigCard: FC = () => {
  const t = useTranslations('organization')
  const { locale } = useLocale()
  const [groups, setGroups] = useState<AgentGroupDto[]>([])
  const [defaults, setDefaults] = useState<Record<string, string | null>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pickerGroup, setPickerGroup] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<VersionDto[] | null>(null)
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [catalogSource, setCatalogSource] = useState<{ source: string; provider: string | null } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/organization/model-config')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as {
        agentGroups: AgentGroupDto[]
        defaults: Record<string, string | null>
        catalogSource: { source: string; provider: string | null } | null
        activeVersion: VersionDto | null
      }
      setGroups(body.agentGroups)
      setDefaults(body.defaults ?? {})
      setCatalogSource(body.catalogSource ?? null)
      const flat: Record<string, string> = {}
      for (const [groupId, value] of Object.entries(body.activeVersion?.overrides ?? {})) {
        if (value?.model) flat[groupId] = value.model
      }
      setSaved(flat)
      setDraft(flat)
      setActiveVersionId(body.activeVersion?.id ?? null)
    } catch {
      toast.error(t('models.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const loadVersions = useCallback(async () => {
    try {
      const res = await fetch('/api/organization/model-config/versions')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { versions: VersionDto[]; activeVersionId: string | null }
      setVersions(body.versions)
      setActiveVersionId(body.activeVersionId)
    } catch {
      toast.error(t('models.loadError'))
    }
  }, [t])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const overrides = Object.fromEntries(Object.entries(draft).map(([g, model]) => [g, { model }]))
      const res = await fetch('/api/organization/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides, comment: comment.trim() || null }),
      })
      if (res.status === 422) {
        const body = (await res.json()) as { details?: Record<string, string> }
        toast.error(`${t('models.saveError')} ${Object.values(body.details ?? {}).join('; ')}`)
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      toast.success(t('models.saved'))
      setComment('')
      await load()
      if (historyOpen) await loadVersions()
    } catch {
      toast.error(t('models.saveError'))
    } finally {
      setSaving(false)
    }
  }, [draft, comment, t, load, loadVersions, historyOpen])

  const handleActivate = useCallback(
    async (versionId: string | 'none') => {
      try {
        const res = await fetch(`/api/organization/model-config/versions/${versionId}/activate`, { method: 'POST' })
        if (!res.ok) throw new Error(String(res.status))
        toast.success(t('models.activated'))
        await load()
        await loadVersions()
      } catch {
        toast.error(t('models.activateError'))
      }
    },
    [t, load, loadVersions],
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="h-8 w-52" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* BYOK (ADR-0022): the picker lists the org's own provider models. */}
      {catalogSource?.source === 'byok' && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('models.byokCatalogHint', { provider: catalogSource.provider ?? 'BYOK' })}
        </p>
      )}
      <ul className="flex flex-col divide-y">
        {groups.map((group) => {
          const override = draft[group.id]
          const defaultModel = defaults[group.id]
          return (
            <li key={group.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4">
              <div className="min-w-0 sm:flex-1">
                <p className="text-sm font-medium">{group.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
              </div>
              <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:shrink-0">
                {override ? (
                  <Badge variant="secondary" className="font-normal">
                    {t('models.overrideBadge')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {t('models.defaultBadge')}
                  </Badge>
                )}
                <code
                  className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs sm:max-w-56 sm:flex-none"
                  title={override ?? defaultModel ?? undefined}
                >
                  {override ?? defaultModel ?? t('models.defaultModel')}
                </code>
                {override && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('models.resetToDefault')}
                    aria-label={`${t('models.resetToDefault')}: ${group.label}`}
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
                      group={group}
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
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{t('models.unsavedChanges')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-config-comment">{t('models.comment')}</Label>
            <Input
              id="model-config-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('models.commentPlaceholder')}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving}>
              {saving ? t('models.saving') : t('models.save')}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setDraft(saved)} disabled={saving}>
              {t('models.discard')}
            </Button>
          </div>
        </div>
      )}

      <Separator />

      <Collapsible
        open={historyOpen}
        onOpenChange={(open) => {
          setHistoryOpen(open)
          if (open && versions === null) void loadVersions()
        }}
      >
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <History className="size-4" aria-hidden />
          {t('models.history')}
          <ChevronDown className="size-3.5" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 flex flex-col gap-2">
            {versions === null && <Spinner className="mx-auto my-4" />}
            {versions !== null && versions.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('models.historyEmpty')}</p>
            )}
            {versions !== null && versions.length > 0 && activeVersionId !== null && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => handleActivate('none')}>
                <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
                {t('models.useDefaults')}
              </Button>
            )}
            {versions?.map((version) => (
              <div key={version.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    {t('models.version')} {version.version}
                    {version.id === activeVersionId && <Badge variant="secondary">{t('models.activeBadge')}</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString(locale)}
                  </span>
                </div>
                {version.comment && <p className="mt-1 text-xs text-muted-foreground">{version.comment}</p>}
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(version.overrides).map(([groupId, value]) => (
                    <li key={groupId}>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {groupId}: {value.model}
                      </code>
                    </li>
                  ))}
                </ul>
                {version.id !== activeVersionId && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => handleActivate(version.id)}>
                    {t('models.activate')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
