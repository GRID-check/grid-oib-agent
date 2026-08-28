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
 * Read-only, for every role including org admin. The quota is set by the
 * platform operator (ADR-0042), so there is no editor here — showing one to an
 * org admin would imply a control they do not have. The READING is shown to
 * everyone: a member whose upload was just refused lands here to find out why.
 */

import { useCallback, useEffect, useState, type FC } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
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
}

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

/** The endpoint this panel reads. Overridable so a preview can name a fixture. */
const STORAGE_ENDPOINT = '/api/organization/storage'

interface StorageUsageCardProps {
  /**
   * Where to read usage from. Defaults to the real endpoint.
   *
   * Exists so the dev preview can render the within-quota and over-quota states
   * side by side and have each card ask for a DISTINCT url. It previously varied
   * the fixture by call ORDER through a `window` counter, which strict mode's
   * double-invocation and any remount made non-deterministic — the screenshot
   * captured whichever state the counter happened to reach, in the artifact whose
   * only job is to show both.
   *
   * A defaulted endpoint is an ordinary component parameter, not a preview-only
   * hatch: production passes nothing and behaves exactly as before.
   */
  endpoint?: string
}

export const StorageUsageCard: FC<StorageUsageCardProps> = ({
  endpoint = STORAGE_ENDPOINT,
}) => {
  const t = useTranslations('organization')
  const [data, setData] = useState<StorageResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint)
      if (!res.ok) throw new Error('load failed')
      setData((await res.json()) as StorageResponse)
    } catch {
      toast.error(t('storage.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t, endpoint])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex min-h-[11.5rem] flex-col gap-4" data-testid="storage-usage-loading">
        <div className="bg-muted h-2.5 w-full animate-pulse rounded-[4px] motion-reduce:animate-none" />
        <div className="bg-muted h-4 w-2/3 animate-pulse rounded motion-reduce:animate-none" />
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">{t('storage.loadError')}</p>
  }

  return (
    <div className="animate-in fade-in-0 flex min-h-[11.5rem] flex-col gap-6 duration-base ease-out motion-reduce:animate-none" data-testid="storage-usage">
      <StorageMeter usedBytes={data.usage.total.bytes} quotaBytes={data.quotaBytes} />

      <div className="flex flex-col gap-2">
        <ScopeRow label={t('storage.projectDocuments')} usage={data.usage.project} />
        <ScopeRow label={t('storage.archivDocuments')} usage={data.usage.archiv} />
      </div>

      {/* Says who owns the number, so nobody hunts for a control that is not
          here. Shown even when unlimited — "no quota" is also a platform
          decision, not an absence of one. */}
      <p className="text-muted-foreground border-t pt-4 text-xs">{t('storage.setByPlatform')}</p>
    </div>
  )
}
