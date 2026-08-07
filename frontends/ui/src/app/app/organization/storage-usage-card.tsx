'use client'

/**
 * Organization storage: bytes stored against the quota that refuses uploads.
 *
 * One meter, because there is one question — how close am I to being cut off.
 * The track IS the quota, so "how full" is literal rather than a rescaled
 * proportion, and the fill carries STATE (within / at-or-over), never category:
 * the two scopes underneath are a text breakdown, not a stacked bar, because
 * "project vs Archiv" is not the decision anyone opens this page to make.
 *
 * Every number is also written out beside the meter. The fill colour is a
 * redundant cue and never the only carrier of state — same rule the spend card
 * follows, for the same accessibility reason.
 *
 * The quota editor appears only for `org:settings:manage` holders, but the
 * READING is shown to everyone: a member whose upload was just refused lands
 * here to find out why, and an empty page would answer nothing.
 */

import { useCallback, useEffect, useState, type FC, type FormEvent } from 'react'
import { AlertTriangle, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBytes } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'

/** Wire shape of `GET /api/organization/storage`. */
interface StorageScopeUsage {
  bytes: number
  documents: number
}

interface StorageResponse {
  usage: {
    project: StorageScopeUsage
    archiv: StorageScopeUsage
    total: StorageScopeUsage
  }
  quotaBytes: number | null
  canManage: boolean
}

/** Quota is entered and displayed in GB — bytes are the wire unit, not a UI one. */
const BYTES_PER_GB = 1e9

/** Fraction of the quota at which "almost full" is worth saying out loud. */
const NEAR_QUOTA_RATIO = 0.9

const StorageMeter: FC<{ usedBytes: number; quotaBytes: number | null }> = ({
  usedBytes,
  quotaBytes,
}) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()

  const over = quotaBytes !== null && usedBytes >= quotaBytes
  const near = !over && quotaBytes !== null && usedBytes >= quotaBytes * NEAR_QUOTA_RATIO
  // Once usage passes the quota the track has to grow to hold it, and a tick
  // marks where the quota sat. The tick only appears in the over state, where
  // the sentence underneath explains it.
  const scale = quotaBytes !== null ? Math.max(quotaBytes, usedBytes) : usedBytes
  const fillPct = scale > 0 ? Math.min((usedBytes / scale) * 100, 100) : 0
  const quotaPct = over && quotaBytes !== null && scale > 0 ? (quotaBytes / scale) * 100 : null

  const reading =
    quotaBytes !== null
      ? t('storage.ofQuota', {
          used: formatBytes(usedBytes, locale),
          quota: formatBytes(quotaBytes, locale),
        })
      : t('storage.noQuota', { used: formatBytes(usedBytes, locale) })

  return (
    <div className="grid-storage-viz">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{t('storage.used')}</p>
        <p className="text-muted-foreground text-right text-xs tabular-nums">{reading}</p>
      </div>
      <div
        className="bg-muted relative mt-1.5 h-2.5 w-full overflow-hidden rounded-[4px]"
        role="img"
        aria-label={`${t('storage.used')}: ${reading}`}
        data-testid={`storage-meter-${over ? 'over' : 'within'}`}
      >
        <div
          className="h-full rounded-r-[4px]"
          style={{
            width: `${fillPct}%`,
            backgroundColor: over ? 'var(--storage-meter-over)' : 'var(--storage-meter)',
          }}
        />
        {quotaPct !== null && (
          <span
            className="bg-foreground/60 absolute inset-y-0 w-px"
            style={{ left: `${quotaPct}%` }}
            aria-hidden
            data-testid="storage-quota-tick"
          />
        )}
      </div>
      {over && (
        <p className="text-destructive mt-1 flex items-center gap-1 text-xs">
          <AlertTriangle className="size-3" aria-hidden />
          {t('storage.overQuota')}
        </p>
      )}
      {near && <p className="text-muted-foreground mt-1 text-xs">{t('storage.nearQuota')}</p>}
    </div>
  )
}

const ScopeRow: FC<{ label: string; usage: StorageScopeUsage }> = ({ label, usage }) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()

  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {formatBytes(usage.bytes, locale)}
        <span className="text-muted-foreground ml-2 text-xs">
          {t('storage.documentCount', { count: String(usage.documents) })}
        </span>
      </span>
    </div>
  )
}

export const StorageUsageCard: FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const t = useTranslations('organization')
  const [data, setData] = useState<StorageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [quotaGb, setQuotaGb] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/organization/storage')
      if (!res.ok) throw new Error('load failed')
      const body = (await res.json()) as StorageResponse
      setData(body)
      setQuotaGb(body.quotaBytes === null ? '' : String(body.quotaBytes / BYTES_PER_GB))
    } catch {
      toast.error(t('storage.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    try {
      const trimmed = quotaGb.trim()
      const quotaBytes = trimmed === '' ? null : Math.round(Number(trimmed) * BYTES_PER_GB)
      const res = await fetch('/api/organization/storage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quotaBytes }),
      })
      if (res.status === 422) {
        toast.error(t('storage.belowUsage'))
        return
      }
      if (!res.ok) throw new Error('save failed')
      setData((await res.json()) as StorageResponse)
      toast.success(t('storage.saved'))
    } catch {
      toast.error(t('storage.saveError'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" data-testid="storage-usage-loading">
        <div className="bg-muted h-2.5 w-full animate-pulse rounded-[4px]" />
        <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">{t('storage.loadError')}</p>
  }

  return (
    <div className="flex flex-col gap-6" data-testid="storage-usage">
      <StorageMeter usedBytes={data.usage.total.bytes} quotaBytes={data.quotaBytes} />

      <div className="flex flex-col gap-2">
        <ScopeRow label={t('storage.projectDocuments')} usage={data.usage.project} />
        <ScopeRow label={t('storage.archivDocuments')} usage={data.usage.archiv} />
      </div>

      {isAdmin && (
        <form className="flex flex-col gap-2 border-t pt-4" onSubmit={onSubmit}>
          <Label htmlFor="storage-quota">{t('storage.quotaLabel')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="storage-quota"
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              className="max-w-32 tabular-nums"
              value={quotaGb}
              onChange={(event) => setQuotaGb(event.target.value)}
              aria-describedby="storage-quota-hint"
            />
            <span className="text-muted-foreground text-sm">{t('storage.quotaUnit')}</span>
            <Button type="submit" disabled={saving}>
              <HardDrive className="size-4" aria-hidden />
              {saving ? t('storage.saving') : t('storage.save')}
            </Button>
          </div>
          <p id="storage-quota-hint" className="text-muted-foreground text-xs">
            {t('storage.quotaHint')}
          </p>
        </form>
      )}
    </div>
  )
}
