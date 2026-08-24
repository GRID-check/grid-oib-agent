'use client'

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { Spinner } from '@/components/ui/spinner'
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

  /**
   * The write that failed, kept so the retry can be the SAME action.
   *
   * Both writes used to `return` on a non-ok response and had no `catch` at
   * all: a refused assignment did exactly nothing on screen — no error, no
   * change, no clue — while the READ path beside it reported its failure and
   * offered a retry. Silence in a popover whose whole job is to say who is
   * responsible reads as success, and going offline turned the click into an
   * unhandled rejection on top.
   */
  const [failedWrite, setFailedWrite] = useState<{
    kind: 'assign' | 'unassign'
    userId: string
    name: string
  } | null>(null)

  const write = async (kind: 'assign' | 'unassign', targetUserId: string, name: string) => {
    setBusy(true)
    setFailedWrite(null)
    const path = `/api/assignments/document/${encodeURIComponent(documentId)}`
    try {
      const res =
        kind === 'assign'
          ? await fetch(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: targetUserId }),
            })
          : await fetch(`${path}?userId=${encodeURIComponent(targetUserId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`assignment ${res.status}`)
      const body = (await res.json()) as { assignees?: FileAssignee[] }
      onChanged(body.assignees ?? [])
    } catch {
      setFailedWrite({ kind, userId: targetUserId, name })
    } finally {
      setBusy(false)
    }
  }

  const displayName = (person: FileAssignee): string => person.name || person.email || person.userId

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
            {triggerLabel ?? (assignees.length > 0 ? t('assignment.edit') : t('assignment.assign'))}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 space-y-2 p-3 duration-quick ease-out motion-reduce:animate-none"
      >
        {!pickOnly &&
          assignees.map((person) => {
            const label = person.name || person.email || person.userId
            return (
              <Item key={person.userId} className="gap-2 px-0 py-0">
                <ItemContent>
                  <ItemTitle className="font-normal">{label}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={busy}
                    aria-label={`${label} · ${t('assignment.unassigned')}`}
                    onClick={() => void write('unassign', person.userId, label)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </ItemActions>
              </Item>
            )
          })}
        {!pickOnly && actorId && !alreadyMine && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={() => void write('assign', actorId, t('assignment.assignToMe'))}
          >
            {t('assignment.assignToMe')}
          </Button>
        )}
        {failedWrite && (
          <div className="space-y-1.5" data-testid="assign-write-error">
            <FieldError>
              {t(failedWrite.kind === 'assign' ? 'assignment.assignError' : 'assignment.unassignError', {
                name: failedWrite.name,
              })}
            </FieldError>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              disabled={busy}
              onClick={() => void write(failedWrite.kind, failedWrite.userId, failedWrite.name)}
            >
              {t('assignment.tryAgain')}
            </Button>
          </div>
        )}
        <SearchField
          type="text"
          value={query}
          onChange={setQuery}
          onClear={() => setQuery('')}
          placeholder={t('assignment.to')}
          label={t('assignment.to')}
          clearLabel={t('browser.clearSearch')}
          inputClassName="h-8"
        />
        <ScrollArea className="h-52 min-h-52">
          {loading && people.length === 0 ? (
            <div className="flex h-full min-h-52 items-center justify-center py-6">
              <Spinner size="sm" label={t('assignment.loadingPeople')} />
            </div>
          ) : loadError ? (
            <div className="space-y-1.5 px-1 py-2">
              <FieldError>{t('assignment.peopleLoadError')}</FieldError>
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
                <Item
                  key={person.userId}
                  asChild
                  className="w-full rounded-md px-2 py-1.5 transition-opacity duration-snap ease-out disabled:opacity-50 motion-reduce:transition-none"
                >
                  <button
                    type="button"
                    disabled={busy || (!pickOnly && assigned)}
                    onClick={() => {
                      if (onPick) {
                        onPick(person)
                        setOpen(false)
                        return
                      }
                      void write('assign', person.userId, displayName(person))
                    }}
                  >
                    <ItemContent>
                      <ItemTitle className="font-normal">{person.name || person.email}</ItemTitle>
                    </ItemContent>
                    {!pickOnly && assigned ? (
                      <ItemActions>
                        <span className="text-muted-foreground text-xs">{t('assignment.responsible')}</span>
                      </ItemActions>
                    ) : null}
                  </button>
                </Item>
              )
            })
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
