'use client'

import { useCallback, useEffect, useState } from 'react'
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

const KIND_LABELS: Record<ProjectMemoryKind, string> = {
  decision: 'Decisions',
  constraint: 'Constraints',
  open_question: 'Open questions',
  derived_fact: 'Derived facts',
  preference: 'Preferences',
}

const KIND_SINGULAR: Record<ProjectMemoryKind, string> = {
  decision: 'Decision',
  constraint: 'Constraint',
  open_question: 'Open question',
  derived_fact: 'Derived fact',
  preference: 'Preference',
}

const VERIFICATION_LABELS: Record<string, string> = {
  unverified: 'unverified',
  source_grounded: 'source-grounded',
  user_confirmed: 'confirmed by you',
}

function provenanceLabel(provenanceType: string): string {
  return provenanceType === 'user' ? 'added by you' : 'noted by Grid'
}

/** Compact relative time ("2h ago", "3d ago") with a date fallback for older items. */
function formatWhen(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d ago`
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function ProjectMemoryPanel({ projectId }: ProjectMemoryPanelProps): JSX.Element {
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
    (signal: { cancelled: boolean }) => {
      setError(null)
      requestJson<{ items: MemoryItem[] }>(baseUrl)
        .then((response) => {
          if (signal.cancelled) return
          setItems(response.items)
        })
        .catch((err: unknown) => {
          if (signal.cancelled) return
          setError(err instanceof Error ? err.message : 'Failed to load project memory')
        })
    },
    [baseUrl],
  )

  useEffect(() => {
    const signal = { cancelled: false }
    load(signal)
    return () => {
      signal.cancelled = true
    }
  }, [load])

  const replaceItem = (updated: MemoryItem) => {
    setItems((prev) => (prev ? prev.map((it) => (it.id === updated.id ? updated : it)) : prev))
  }

  const patchItem = async (target: MemoryItem, body: Record<string, unknown>) => {
    setBusyId(target.id)
    try {
      const { item } = await requestJson<{ item: MemoryItem }>(itemUrl(target), {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      replaceItem(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusyId(null)
    }
  }

  const deleteItem = async (target: MemoryItem) => {
    setBusyId(target.id)
    try {
      await requestJson<undefined>(itemUrl(target), { method: 'DELETE' })
      setItems((prev) => (prev ? prev.filter((it) => it.id !== target.id) : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
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
      )
      setItems((prev) => (prev ? [item, ...prev] : [item]))
      setAddContent('')
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add memory')
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
            Project memory
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What Grid has learned about this project — editable.
          </p>
        </div>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add memory
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={addKind} onValueChange={(value) => setAddKind(value as ProjectMemoryKind)}>
              <SelectTrigger className="w-44" aria-label="Memory kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_MEMORY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {KIND_SINGULAR[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={addScope}
              onValueChange={(value) => setAddScope(value as 'project' | 'organization')}
            >
              <SelectTrigger className="w-44" aria-label="Memory scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">This project</SelectItem>
                <SelectItem value="organization">All my projects</SelectItem>
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
            placeholder="One concise, self-contained finding about this project…"
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
              Cancel
            </Button>
            <Button size="sm" onClick={submitAdd} disabled={addBusy || addContent.trim().length === 0}>
              Add
            </Button>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Something went wrong with project memory</AlertTitle>
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
              Try again
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
          title="Nothing recorded yet"
          description="Grid hasn't recorded anything about this project yet. It will as you chat — or add something yourself."
        />
      )}

      {!error && items !== null && groups.length > 0 && (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="border-b bg-muted/40 px-6 py-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {KIND_LABELS[group.kind]}
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
                                Save
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingId(null)}
                                disabled={busy}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="flex items-start gap-1.5 text-sm leading-relaxed">
                              {item.pinned && (
                                <Pin
                                  className="mt-1 size-3 shrink-0 text-muted-foreground"
                                  aria-label="Pinned"
                                />
                              )}
                              <span className="min-w-0">{item.content}</span>
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.scope === 'organization' && (
                                <>
                                  <span className="font-medium">org-wide</span>
                                  {' · '}
                                </>
                              )}
                              {item.confidence} confidence
                              {' · '}
                              {VERIFICATION_LABELS[item.verification] ?? item.verification}
                              {' · '}
                              {provenanceLabel(item.provenanceType)}
                              {' · '}
                              {formatWhen(item.updatedAt)}
                            </p>
                          </>
                        )}
                      </div>

                      {!isEditing && (
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                          {isConfirmingDelete ? (
                            <>
                              <span className="text-xs text-muted-foreground">Remove?</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-destructive hover:text-destructive"
                                onClick={() => deleteItem(item)}
                                disabled={busy}
                              >
                                Remove
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                onClick={() => setConfirmingDeleteId(null)}
                                disabled={busy}
                                aria-label="Cancel removal"
                                title="Cancel"
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
                                aria-label={item.pinned ? 'Unpin' : 'Pin'}
                                title={item.pinned ? 'Unpin — stop always including this' : 'Pin — always include this in context'}
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
                                  aria-label="Confirm"
                                  title="Confirm — mark this as correct"
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
                                aria-label="Edit"
                                title="Edit"
                              >
                                <Pencil className="size-3.5" aria-hidden />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirmingDeleteId(item.id)}
                                disabled={busy}
                                aria-label="Remove"
                                title="Remove from memory"
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
