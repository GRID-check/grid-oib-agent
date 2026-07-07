'use client'

/**
 * Org-admin editor for runtime model configuration (ADR-0014).
 *
 * Per agent group: shows the current override (or "workflow default") and a
 * search picker that only lists models passing the group's capability
 * requirements (server-filtered via /api/organization/model-config/models).
 * Saving creates a new immutable version; the history panel lists versions
 * and offers one-click rollback (activate).
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, History, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

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
  tokens >= 1000 ? `${Math.round(tokens / 1024)}k` : String(tokens)

/** USD per million tokens, from the catalog's per-token price. */
const perMillion = (perToken: number): string => `$${(perToken * 1_000_000).toFixed(2)}`

const ModelPicker: FC<{
  group: AgentGroupDto
  onPick: (modelId: string) => void
  onClose: () => void
}> = ({ group, onPick, onClose }) => {
  const t = useTranslations('organization')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelDto[] | null>(null)
  const [loading, setLoading] = useState(false)
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
    <div className="mt-2 rounded-md border bg-background p-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          aria-label={t('models.searchPlaceholder')}
        />
        <Button variant="ghost" size="sm" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="mt-2 max-h-56 overflow-y-auto" role="listbox">
        {loading && <Spinner className="mx-auto my-4" />}
        {!loading && models && models.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t('models.noResults')}</p>
        )}
        {!loading &&
          models?.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected="false"
              className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => onPick(model.id)}
            >
              <span className="truncate font-mono">{model.id}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('models.contextWindow')} {formatContext(model.contextLength)} ·{' '}
                {perMillion(model.promptPrice)} / {perMillion(model.completionPrice)}
              </span>
            </button>
          ))}
      </div>
    </div>
  )
}

export const ModelConfigCard: FC = () => {
  const t = useTranslations('organization')
  const [groups, setGroups] = useState<AgentGroupDto[]>([])
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pickerGroup, setPickerGroup] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<VersionDto[] | null>(null)
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/organization/model-config')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as {
        agentGroups: AgentGroupDto[]
        activeVersion: VersionDto | null
      }
      setGroups(body.agentGroups)
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
    return <Spinner className="mx-auto my-6" />
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y">
        {groups.map((group) => (
          <li key={group.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{group.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 text-xs">
                  {draft[group.id] ?? t('models.defaultModel')}
                </code>
                {draft[group.id] && (
                  <Button
                    variant="ghost"
                    size="sm"
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerGroup((current) => (current === group.id ? null : group.id))}
                >
                  {t('models.change')}
                </Button>
              </div>
            </div>
            {pickerGroup === group.id && (
              <ModelPicker
                group={group}
                onClose={() => setPickerGroup(null)}
                onPick={(modelId) => {
                  setDraft((prev) => ({ ...prev, [group.id]: modelId }))
                  setPickerGroup(null)
                }}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Label htmlFor="model-config-comment">{t('models.comment')}</Label>
        <Input
          id="model-config-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t('models.commentPlaceholder')}
          maxLength={500}
        />
      </div>
      <div>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? t('models.saving') : t('models.save')}
        </Button>
      </div>

      <Collapsible
        open={historyOpen}
        onOpenChange={(open) => {
          setHistoryOpen(open)
          if (open && versions === null) void loadVersions()
        }}
      >
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <History className="size-4" aria-hidden />
          {t('models.history')}
          <ChevronDown className="size-3.5" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 flex flex-col gap-2">
            {versions !== null && versions.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('models.historyEmpty')}</p>
            )}
            {versions !== null && versions.length > 0 && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => handleActivate('none')}>
                {t('models.useDefaults')}
              </Button>
            )}
            {versions?.map((version) => (
              <div key={version.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {t('models.version')} {version.version}
                    {version.id === activeVersionId && (
                      <Badge className="ml-2" variant="secondary">
                        {t('models.activeBadge')}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString()} · {version.createdBy}
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
