'use client'

/**
 * Platform → storage. Every tenant's consumption, and the quota that bounds it.
 *
 * A TABLE, not meters. The org-side panel answers one tenant's "am I about to be
 * cut off"; this answers the operator's "who is about to cause a problem and
 * what do I do about it", which is a comparison across rows. Rows are ordered by
 * consumption for the same reason — alphabetical would bury the answer.
 *
 * The bar in each row is a proportion-of-quota cue, deliberately secondary: the
 * numbers are written out beside it, and the bar is never the only carrier of
 * state (the over/near copy is text).
 *
 * Editing is inline and one row at a time. A bulk editor would be faster to
 * build and much easier to get wrong — a quota is a commercial commitment per
 * tenant, and there is no plausible reason to change twelve at once.
 */

import { useCallback, useEffect, useState, type FC, type FormEvent } from 'react'
import { AlertTriangle, Check, Loader2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatBytes } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'

interface OrganizationStorageRow {
  organizationId: string
  displayName: string | null
  usedBytes: number
  documents: number
  quotaBytes: number | null
  inherited: boolean
}

interface PlatformStorageResponse {
  organizations: OrganizationStorageRow[]
  totals: { usedBytes: number; documents: number; organizations: number }
}

/** Quotas are entered in GB; bytes are the wire unit, never a UI one. */
const BYTES_PER_GB = 1e9
const NEAR_QUOTA_RATIO = 0.9

const QuotaBar: FC<{ usedBytes: number; quotaBytes: number | null }> = ({
  usedBytes,
  quotaBytes,
}) => {
  if (quotaBytes === null) {
    return <div className="bg-muted h-1.5 w-full rounded-[3px]" aria-hidden />
  }
  const over = usedBytes >= quotaBytes
  const scale = Math.max(quotaBytes, usedBytes)
  const fillPct = scale > 0 ? Math.min((usedBytes / scale) * 100, 100) : 0

  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-[3px]" aria-hidden>
      <div
        className="h-full rounded-r-[3px]"
        style={{
          width: `${fillPct}%`,
          backgroundColor: over ? 'var(--storage-meter-over)' : 'var(--storage-meter)',
        }}
      />
    </div>
  )
}

export const PlatformStorageTable: FC = () => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const [data, setData] = useState<PlatformStorageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftGb, setDraftGb] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/storage')
      if (!res.ok) throw new Error('load failed')
      setData((await res.json()) as PlatformStorageResponse)
    } catch {
      toast.error(t('storage.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (row: OrganizationStorageRow): void => {
    setEditing(row.organizationId)
    // An inherited quota starts blank rather than pre-filled with the default:
    // pre-filling would turn "opening the editor and pressing save" into
    // silently pinning the org to today's default forever.
    setDraftGb(row.inherited || row.quotaBytes === null ? '' : String(row.quotaBytes / BYTES_PER_GB))
  }

  const submit = async (event: FormEvent<HTMLFormElement>, organizationId: string): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    try {
      const trimmed = draftGb.trim()
      const quotaBytes = trimmed === '' ? null : Math.round(Number(trimmed) * BYTES_PER_GB)
      const res = await fetch(
        `/api/platform/organizations/${encodeURIComponent(organizationId)}/storage`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quotaBytes }),
        },
      )
      if (res.status === 422) {
        toast.error(t('storage.belowUsage'))
        return
      }
      if (!res.ok) throw new Error('save failed')
      toast.success(t('storage.saved'))
      setEditing(null)
      await load()
    } catch {
      toast.error(t('storage.saveError'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3" data-testid="platform-storage-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-muted h-10 w-full animate-pulse rounded" />
        ))}
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">{t('storage.loadError')}</p>
  }

  if (data.organizations.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('storage.empty')}</p>
  }

  return (
    <div className="grid-storage-viz flex flex-col gap-4" data-testid="platform-storage">
      <p className="text-muted-foreground text-sm">
        {t('storage.totals', {
          used: formatBytes(data.totals.usedBytes, locale),
          orgs: String(data.totals.organizations),
        })}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs">
              <th className="py-2 pr-4 font-medium">{t('storage.columnOrg')}</th>
              <th className="py-2 pr-4 text-right font-medium">{t('storage.columnUsed')}</th>
              <th className="py-2 pr-4 text-right font-medium">{t('storage.columnQuota')}</th>
              <th className="w-px py-2" />
            </tr>
          </thead>
          <tbody>
            {data.organizations.map((row) => {
              const over = row.quotaBytes !== null && row.usedBytes >= row.quotaBytes
              const near =
                !over && row.quotaBytes !== null && row.usedBytes >= row.quotaBytes * NEAR_QUOTA_RATIO

              return (
                <tr key={row.organizationId} className="border-b last:border-0 align-middle">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{row.displayName ?? row.organizationId}</div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {row.organizationId}
                    </div>
                    <div className="mt-1.5 max-w-48">
                      <QuotaBar usedBytes={row.usedBytes} quotaBytes={row.quotaBytes} />
                    </div>
                    {over && (
                      <p className="text-destructive mt-1 flex items-center gap-1 text-xs">
                        <AlertTriangle className="size-3" aria-hidden />
                        {t('storage.rowOver')}
                      </p>
                    )}
                    {near && (
                      <p className="text-muted-foreground mt-1 text-xs">{t('storage.rowNear')}</p>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {formatBytes(row.usedBytes, locale)}
                    <div className="text-muted-foreground text-xs">
                      {t('storage.rowDocuments', { count: String(row.documents) })}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {editing === row.organizationId ? (
                      <form
                        className="flex items-center justify-end gap-1"
                        onSubmit={(event) => void submit(event, row.organizationId)}
                      >
                        <Input
                          autoFocus
                          type="number"
                          min="0"
                          step="1"
                          inputMode="decimal"
                          aria-label={t('storage.columnQuota')}
                          className="h-8 w-24 tabular-nums"
                          value={draftGb}
                          onChange={(event) => setDraftGb(event.target.value)}
                        />
                        <span className="text-muted-foreground text-xs">GB</span>
                        <Button type="submit" size="sm" variant="ghost" disabled={saving}>
                          {saving ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <Check className="size-4" aria-hidden />
                          )}
                          <span className="sr-only">{t('storage.save')}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                        >
                          <X className="size-4" aria-hidden />
                          <span className="sr-only">{t('storage.cancel')}</span>
                        </Button>
                      </form>
                    ) : (
                      <>
                        {row.quotaBytes === null
                          ? t('storage.unlimited')
                          : formatBytes(row.quotaBytes, locale)}
                        {row.inherited && (
                          <div className="text-muted-foreground text-xs">
                            {t('storage.inherited')}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="py-3">
                    {editing !== row.organizationId && (
                      <Button size="sm" variant="ghost" onClick={() => startEdit(row)}>
                        <Pencil className="size-4" aria-hidden />
                        <span className="sr-only">
                          {t('storage.edit', { org: row.displayName ?? row.organizationId })}
                        </span>
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground text-xs">{t('storage.hint')}</p>
    </div>
  )
}
