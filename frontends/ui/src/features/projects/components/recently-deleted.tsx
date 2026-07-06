'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface DeletionEntry {
  id: string
  entityType: string
  entityId: string
  displayName: string
  purgeAfter: string
  status: 'pending' | 'failed'
  lastError: string | null
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * Org-admin panel of pending deletions with restore. Renders nothing for
 * non-admins (the API returns 403) or when there is nothing pending.
 */
export function RecentlyDeleted() {
  const [entries, setEntries] = useState<DeletionEntry[]>([])
  /** Entry currently being restored — disables its button to avoid double-fires. */
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/deletions')
    if (!res.ok) return
    const rows: DeletionEntry[] = await res.json()
    setEntries(rows.filter((row) => row.entityType === 'project'))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRestore = async (entry: DeletionEntry) => {
    setRestoringId(entry.id)
    try {
      const res = await fetch(`/api/projects/${entry.entityId}/restore`, {
        method: 'POST',
      })
      if (res.ok) {
        toast.success(`Restored "${entry.displayName}".`)
        await refresh()
      } else {
        const data = await res.json().catch(() => null)
        toast.error(data?.error ?? 'Restore failed.')
      }
    } catch {
      toast.error('Restore failed.')
    } finally {
      setRestoringId(null)
    }
  }

  if (entries.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Recently deleted
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center justify-between rounded-lg border p-3"
          >
            <div>
              <p className="text-sm font-medium">{entry.displayName}</p>
              <p className="text-xs text-muted-foreground">
                {entry.status === 'failed'
                  ? 'Purge failed — contact support'
                  : `Permanently purged after ${dateFormatter.format(new Date(entry.purgeAfter))}`}
              </p>
              {entry.status === 'failed' && entry.lastError && (
                <p className="mt-0.5 break-words font-mono text-[11px] text-destructive/80">
                  {entry.lastError}
                </p>
              )}
            </div>
            {entry.status === 'pending' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleRestore(entry)}
                disabled={restoringId === entry.id}
              >
                {restoringId === entry.id && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
