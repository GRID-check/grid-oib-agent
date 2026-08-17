'use client'

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useChatStore } from '@/features/chat'
import { useTranslations } from '@/i18n'
import type { FileAssignee } from './project-file-workspace'

export function AssignPopover({
  documentId,
  assignees,
  currentUserId,
  onChanged,
  onPick,
  pickOnly = false,
  triggerLabel,
  trigger,
}: {
  documentId: string
  assignees: readonly FileAssignee[]
  currentUserId?: string
  onChanged: (next: FileAssignee[]) => void
  onPick?: (person: FileAssignee) => void
  pickOnly?: boolean
  triggerLabel?: string
  /** Viewport-dressed trigger. Default is the Files ghost button. */
  trigger?: ReactElement
}) {
  const t = useTranslations('files')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionUserId = useChatStore((state) => state.currentUserId)
  const actorId = currentUserId ?? sessionUserId ?? undefined
  const alreadyMine = Boolean(actorId && assignees.some((person) => person.userId === actorId))
  const [people, setPeople] = useState<FileAssignee[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    void fetch(`/api/assignments/document/${encodeURIComponent(documentId)}/candidates`)
      .then((res) => {
        if (!res.ok) throw new Error(`candidates ${res.status}`)
        return res.json() as Promise<{ candidates?: FileAssignee[] }>
      })
      .then((body) => {
        if (cancelled) return
        setPeople(body.candidates ?? [])
      })
      .catch(() => {
        // A failed load must not pose as "nobody in this project".
        if (!cancelled) {
          setPeople([])
          setLoadError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, documentId, attempt])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return people.filter((person) => {
      if (!needle) return true
      const name = (person.name || '').toLowerCase()
      const email = (person.email || '').toLowerCase()
      return name.includes(needle) || email.includes(needle)
    })
  }, [people, query])

  const post = async (targetUserId: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/assignments/document/${documentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: targetUserId }),
      })
      if (!res.ok) return
      const body = (await res.json()) as { assignees?: FileAssignee[] }
      onChanged(body.assignees ?? [])
    } finally {
      setBusy(false)
    }
  }

  const remove = async (targetUserId: string) => {
    setBusy(true)
    try {
      const res = await fetch(
        `/api/assignments/document/${documentId}?userId=${encodeURIComponent(targetUserId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) return
      const body = (await res.json()) as { assignees?: FileAssignee[] }
      onChanged(body.assignees ?? [])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]">
            {triggerLabel ?? (assignees.length > 0 ? t('assignment.edit') : t('assignment.assign'))}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 p-3">
        {!pickOnly &&
          assignees.map((person) => (
            <div key={person.userId} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{person.name || person.email || person.userId}</span>
              <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => void remove(person.userId)}>
                ×
              </Button>
            </div>
          ))}
        {!pickOnly && actorId && !alreadyMine && (
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => void post(actorId)}>
            {t('assignment.assignToMe')}
          </Button>
        )}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('assignment.to')}
          aria-label={t('assignment.to')}
          className="h-8"
          disabled={busy}
        />
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {loading && people.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-xs">{t('assignment.loadingPeople')}</p>
          ) : loadError ? (
            <div className="space-y-1.5 px-1 py-2">
              <p className="text-destructive text-xs" role="alert">
                {t('assignment.peopleLoadError')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => setAttempt((current) => current + 1)}
              >
                {t('assignment.tryAgain')}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-xs">{t('assignment.noPeople')}</p>
          ) : (
            filtered.map((person) => {
              const assigned = assignees.some((row) => row.userId === person.userId)
              return (
                <button
                  key={person.userId}
                  type="button"
                  disabled={busy || (!pickOnly && assigned)}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-50"
                  onClick={() => {
                    if (onPick) {
                      onPick(person)
                      setOpen(false)
                      return
                    }
                    void post(person.userId)
                  }}
                >
                  <span className="truncate">{person.name || person.email}</span>
                  {!pickOnly && assigned ? (
                    <span className="text-muted-foreground text-[11px]">{t('assignment.responsible')}</span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
