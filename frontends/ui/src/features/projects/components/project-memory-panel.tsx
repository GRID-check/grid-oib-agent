'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Brain, Check, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import {
  PROJECT_MEMORY_KINDS,
  type ProjectMemoryItem,
  type ProjectMemoryKind,
} from '@/lib/db/schema'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'

/**
 * Project Memory panel — "What Grid knows about this project".
 * See docs/architecture/project-memory-design.md §7: capture is silent, this
 * panel is the human backstop (view / add / edit / confirm / pin / dismiss).
 */

/** Memory item as it arrives over the wire (timestamps serialize to strings). */
type MemoryItem = Omit<ProjectMemoryItem, 'createdAt' | 'updatedAt' | 'lastReferencedAt'> & {
  createdAt: string
  updatedAt: string
  lastReferencedAt: string | null
}

interface ProjectMemoryPanelProps {
  projectId: string
}

const KNOWN_VERIFICATIONS = ['unverified', 'source_grounded', 'user_confirmed']

function verificationLabel(verification: string, t: Translator): string {
  return KNOWN_VERIFICATIONS.includes(verification)
    ? t(`memory.verification.${verification}`)
    : verification
}

function provenanceLabel(provenanceType: string, t: Translator): string {
  return provenanceType === 'user' ? t('memory.provenance.user') : t('memory.provenance.grid')
}

/** Compact relative time ("2h ago", "3d ago") with a date fallback for older items. */
function formatWhen(isoDate: string, t: Translator): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return t('memory.time.justNow')
  if (seconds < 3600) return t('memory.time.minutesAgo', { count: Math.round(seconds / 60) })
  if (seconds < 86400) return t('memory.time.hoursAgo', { count: Math.round(seconds / 3600) })
  if (seconds < 86400 * 30) return t('memory.time.daysAgo', { count: Math.round(seconds / 86400) })
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

async function requestJson<T>(url: string, init?: RequestInit, t?: Translator): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!res.ok) {
    throw new Error(
      t ? t('memory.errors.requestFailed', { status: res.status }) : `Request failed (${res.status})`,
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function ProjectMemoryPanel({ projectId }: ProjectMemoryPanelProps): JSX.Element {
  const t = useTranslations('projects')
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Item currently being mutated — disables its actions to avoid double-fires. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  // Add form
  const [adding, setAdding] = useState(false)
  const [addKind, setAddKind] = useState<ProjectMemoryKind>('decision')
  const [addScope, setAddScope] = useState<'project' | 'organization'>('project')
  const [addContent, setAddContent] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const baseUrl = `/api/projects/${projectId}/memory`
  const orgUrl = '/api/organization/memory'

  /** Org-wide items are managed through the organization endpoint. */
  const itemUrl = (item: MemoryItem) =>
    item.scope === 'organization' ? `${orgUrl}/${item.id}` : `${baseUrl}/${item.id}`

  const load = useCallback(
    (signal: { cancelled: boolean }, { silent = false }: { silent?: boolean } = {}) => {
      // A silent refetch (focus/interval revalidation) must not flash the
      // skeleton or clear an existing error banner — it only swaps in fresh
      // items when they arrive. The initial load is non-silent.
      if (!silent) setError(null)
      requestJson<{ items: MemoryItem[] }>(baseUrl, undefined, t)
        .then((response) => {
          if (signal.cancelled) return
          setItems(response.items)
          if (silent) setError(null)
        })
        .catch((err: unknown) => {
          if (signal.cancelled || silent) return
          setError(err instanceof Error ? err.message : t('memory.errors.loadFailed'))
        })
    },
    [baseUrl],
  )

  // Initial load.
  useEffect(() => {
    const signal = { cancelled: false }
    load(signal)
    return () => {
      signal.cancelled = true
    }
  }, [load])

  // Pause silent revalidation while the user is actively mutating (adding,
  // editing, deleting, or a request is in flight) so a background refetch never
  // clobbers optimistic UI or an open editor.
  const interacting = adding || editingId !== null || busyId !== null || confirmingDeleteId !== null
  const interactingRef = useRef(interacting)
  interactingRef.current = interacting

  // Revalidate so memory captured elsewhere (the chat `remember` tool and the
  // async reflection stage both write out-of-band) shows up without a manual
  // reload: on window focus / tab re-visibility, and on a slow interval while
  // the panel is mounted. Silent — never flashes the skeleton.
  useEffect(() => {
    const signal = { cancelled: false }
    const revalidate = () => {
      if (interactingRef.current) return
      if (document.visibilityState === 'visible') load(signal, { silent: true })
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', revalidate)
    const interval = window.setInterval(revalidate, 30_000)
    return () => {
      signal.cancelled = true
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
      window.clearInterval(interval)
    }
  }, [load])

  const replaceItem = (updated: MemoryItem) => {
    setItems((prev) => (prev ? prev.map((it) => (it.id === updated.id ? updated : it)) : prev))
  }

  const patchItem = async (target: MemoryItem, body: Record<string, unknown>) => {
    setBusyId(target.id)
    try {
      const { item } = await requestJson<{ item: MemoryItem }>(
        itemUrl(target),
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
        t,
      )
      replaceItem(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.errors.updateFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const deleteItem = async (target: MemoryItem) => {
    setBusyId(target.id)
    try {
      await requestJson<undefined>(itemUrl(target), { method: 'DELETE' }, t)
      setItems((prev) => (prev ? prev.filter((it) => it.id !== target.id) : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.errors.deleteFailed'))
    } finally {
      setBusyId(null)
      setConfirmingDeleteId(null)
    }
  }

  const submitAdd = async () => {
    const content = addContent.trim()
    if (!content) return
    setAddBusy(true)
    try {
      const { item } = await requestJson<{ item: MemoryItem }>(
        addScope === 'organization' ? orgUrl : baseUrl,
        {
          method: 'POST',
          body: JSON.stringify({ kind: addKind, content }),
        },
        t,
      )
      setItems((prev) => (prev ? [item, ...prev] : [item]))
      setAddContent('')
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memory.errors.addFailed'))
    } finally {
      setAddBusy(false)
    }
  }

  const startEdit = (item: MemoryItem) => {
    setEditingId(item.id)
    setEditDraft(item.content)
    setConfirmingDeleteId(null)
  }

  const submitEdit = async (target: MemoryItem) => {
    const content = editDraft.trim()
    if (!content) return
    await patchItem(target, { content })
    setEditingId(null)
  }

  const visible = items?.filter((it) => it.status !== 'superseded' && it.status !== 'dismissed') ?? []
  const groups = PROJECT_MEMORY_KINDS.map((kind) => ({
    kind,
    items: visible.filter((it) => it.kind === kind),
  })).filter((group) => group.items.length > 0)

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('memory.heading')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('memory.description')}</p>
        </div>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            {t('memory.addMemory')}
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={addKind} onValueChange={(value) => setAddKind(value as ProjectMemoryKind)}>
              <SelectTrigger className="w-44" aria-label={t('memory.kindAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_MEMORY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`memory.kindSingular.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={addScope}
              onValueChange={(value) => setAddScope(value as 'project' | 'organization')}
            >
              <SelectTrigger className="w-44" aria-label={t('memory.scopeAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">{t('memory.scopeProject')}</SelectItem>
                <SelectItem value="organization">{t('memory.scopeOrganization')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={addContent}
            onChange={(event) => setAddContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setAdding(false)
                setAddContent('')
              }
            }}
            placeholder={t('memory.addPlaceholder')}
            rows={2}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false)
                setAddContent('')
              }}
              disabled={addBusy}
            >
              {t('memory.cancel')}
            </Button>
            <Button size="sm" onClick={submitAdd} disabled={addBusy || addContent.trim().length === 0}>
              {t('memory.add')}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('memory.errors.title')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setItems(null)
                load({ cancelled: false })
              }}
            >
              {t('memory.tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!error && items === null && (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="space-y-2 px-6 py-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!error && items !== null && groups.length === 0 && (
        <EmptyState
          icon={Brain}
          title={t('memory.emptyTitle')}
          description={t('memory.emptyDescription')}
        />
      )}

      {!error && items !== null && groups.length > 0 && (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="border-b bg-muted/40 px-6 py-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {t(`memory.kinds.${group.kind}`)}
              </div>
              <div className="divide-y divide-border">
                {group.items.map((item) => {
                  const busy = busyId === item.id
                  const isEditing = editingId === item.id
                  const isConfirmingDelete = confirmingDeleteId === item.id
                  return (
                    <div
                      key={item.id}
                      className="group flex items-start justify-between gap-4 px-6 py-3.5 transition-colors duration-200 ease-out hover:bg-accent/40"
                    >
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setEditingId(null)
                                }
                              }}
                              rows={2}
                              autoFocus
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => submitEdit(item)}
                                disabled={busy || editDraft.trim().length === 0}
                              >
                                {t('memory.save')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingId(null)}
                                disabled={busy}
                              >
                                {t('memory.cancel')}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="flex items-start gap-1.5 text-sm leading-relaxed">
                              {item.pinned && (
                                <Pin
                                  className="mt-1 size-3 shrink-0 text-muted-foreground"
                                  aria-label={t('memory.pinned')}
                                />
                              )}
                              <span className="min-w-0">{item.content}</span>
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.scope === 'organization' && (
                                <>
                                  <span className="font-medium">{t('memory.orgWide')}</span>
                                  {' · '}
                                </>
                              )}
                              {t('memory.confidence', { confidence: item.confidence })}
                              {' · '}
                              {verificationLabel(item.verification, t)}
                              {' · '}
                              {provenanceLabel(item.provenanceType, t)}
                              {' · '}
                              {formatWhen(item.updatedAt, t)}
                            </p>
                          </>
                        )}
                      </div>

                      {!isEditing && (
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                          {isConfirmingDelete ? (
                            <>
                              <span className="text-xs text-muted-foreground">{t('memory.removeConfirm')}</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-destructive hover:text-destructive"
                                onClick={() => deleteItem(item)}
                                disabled={busy}
                              >
                                {t('memory.remove')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                onClick={() => setConfirmingDeleteId(null)}
                                disabled={busy}
                                aria-label={t('memory.cancelRemovalAria')}
                                title={t('memory.cancelTitle')}
                              >
                                <X className="size-3.5" aria-hidden />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-foreground"
                                onClick={() => patchItem(item, { pinned: !item.pinned })}
                                disabled={busy}
                                aria-label={item.pinned ? t('memory.unpin') : t('memory.pin')}
                                title={item.pinned ? t('memory.unpinTitle') : t('memory.pinTitle')}
                              >
                                {item.pinned ? (
                                  <PinOff className="size-3.5" aria-hidden />
                                ) : (
                                  <Pin className="size-3.5" aria-hidden />
                                )}
                              </Button>
                              {item.verification !== 'user_confirmed' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 text-muted-foreground hover:text-foreground"
                                  onClick={() => patchItem(item, { verification: 'user_confirmed' })}
                                  disabled={busy}
                                  aria-label={t('memory.confirm')}
                                  title={t('memory.confirmTitle')}
                                >
                                  <Check className="size-3.5" aria-hidden />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-foreground"
                                onClick={() => startEdit(item)}
                                disabled={busy}
                                aria-label={t('memory.edit')}
                                title={t('memory.editTitle')}
                              >
                                <Pencil className="size-3.5" aria-hidden />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirmingDeleteId(item.id)}
                                disabled={busy}
                                aria-label={t('memory.removeAria')}
                                title={t('memory.removeTitle')}
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
