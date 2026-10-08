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
 * state (the over/near copy is text, with an icon).
 *
 * Editing is inline and one row at a time. A bulk editor would be faster to
 * build and much easier to get wrong — a quota is a commercial commitment per
 * tenant, and there is no plausible reason to change twelve at once. Writing
 * needs `platform:organizations:manage`; a read-only viewer gets no pencil and
 * no actions column at all.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState, type FC, type FormEvent } from 'react'
import { AlertTriangle, Check, HardDrive, Pencil, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupText } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { usePlatformCan } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatBytes, formatCount } from '@/lib/format'
import { formatQuotaDraft, parseQuotaDraft, type QuotaDraft } from '@/lib/storage/contract'
import { formatDecimalInput, parseDecimalInput } from '@/lib/text/parse-decimal'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

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
  truncated?: boolean
}

const NEAR_QUOTA_RATIO = 0.9

/**
 * The typed quota, read in two steps: the shared strict decimal parse first (so
 * "2,5" is 2.5 GB and "12x" or "0x10" is not a number), then the storage
 * contract's own judgement of the byte count. Blank is still "unlimited",
 * which the hint under the table says in words.
 */
export function readQuotaInput(raw: string, locale: string): QuotaDraft {
  const parsed = parseDecimalInput(raw, locale)
  if (parsed.status === 'blank') return parseQuotaDraft('')
  if (parsed.status === 'invalid') return { ok: false, reason: 'notANumber' }
  return parseQuotaDraft(String(parsed.value))
}

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
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.organizationsManage)
  const [data, setData] = useState<PlatformStorageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftGb, setDraftGb] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const request = useRef(0)

  const load = useCallback(async () => {
    // A reload that loses the race to a newer one must not overwrite it.
    const id = ++request.current
    setLoading(true)
    try {
      const res = await fetch('/api/platform/storage')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as PlatformStorageResponse
      if (id !== request.current) return
      setData(body)
      setLoadFailed(false)
    } catch {
      if (id === request.current) setLoadFailed(true)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (row: OrganizationStorageRow): void => {
    setEditing(row.organizationId)
    setDraftError(null)
    // An inherited quota starts blank rather than pre-filled with the default:
    // pre-filling would turn "opening the editor and pressing save" into
    // silently pinning the org to today's default forever.
    setDraftGb(
      row.inherited || row.quotaBytes === null
        ? ''
        : formatDecimalInput(Number(formatQuotaDraft(row.quotaBytes)), locale)
    )
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setDraftError(null)
  }

  const submit = async (
    event: FormEvent<HTMLFormElement>,
    organizationId: string
  ): Promise<void> => {
    event.preventDefault()

    // Parsed BEFORE anything is sent. `null` is how this API spells UNLIMITED,
    // so a value that is not a number must never reach the body — it is a field
    // error that keeps the editor open.
    const draft = readQuotaInput(draftGb, locale)
    if (!draft.ok) {
      // Two messages, because the two rejections need different advice: one says
      // "that is not a quota", the other says "that number is too big to carry".
      setDraftError(
        draft.reason === 'tooLarge' ? t('storage.quotaTooLarge') : t('storage.invalidQuota')
      )
      return
    }

    setSaving(true)
    try {
      const res = await fetch(
        `/api/platform/organizations/${encodeURIComponent(organizationId)}/storage`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quotaBytes: draft.quotaBytes }),
        }
      )
      if (!res.ok) {
        // The translated sentence is the message; the server's own words, when
        // it sent any, are the secondary detail rather than the headline.
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(res.status === 422 ? t('storage.belowUsage') : t('storage.saveError'), {
          description: body?.error,
        })
        return
      }
      toast.success(t('storage.saved'))
      cancelEdit()
      await load()
    } catch {
      toast.error(t('storage.saveError'))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data && !loadFailed) {
    return (
      <div className="flex flex-col gap-3" data-testid="platform-storage-loading" aria-busy>
        <Skeleton className="h-4 w-56" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  const retryButton = (
    <Button
      variant="outline"
      size="sm"
      className="mt-2"
      onClick={() => void load()}
      disabled={loading}
    >
      <RefreshCw
        className={loading ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'}
        aria-hidden
      />
      {t('retry')}
    </Button>
  )

  if (!data) {
    return (
      <Alert variant="destructive" data-testid="platform-storage-error">
        <AlertTriangle aria-hidden />
        <AlertTitle className="line-clamp-none">{t('storage.loadError')}</AlertTitle>
        <AlertDescription>
          <p>{t('loadErrorHint')}</p>
          {retryButton}
        </AlertDescription>
      </Alert>
    )
  }

  if (data.organizations.length === 0) {
    return <EmptyState variant="bare" icon={HardDrive} title={t('storage.empty')} />
  }

  return (
    <div
      className="grid-storage-viz flex flex-col gap-4"
      data-testid="platform-storage"
      aria-busy={loading || undefined}
    >
      {loadFailed ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none">{t('storage.refreshError')}</AlertTitle>
          <AlertDescription>{retryButton}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-muted-foreground text-sm tabular-nums">
        {t('storage.totals', {
          used: formatBytes(data.totals.usedBytes, locale),
          orgs: formatCount(data.totals.organizations, locale),
        })}
      </p>

      <div className="@container rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('storage.columnOrg')}</TableHead>
              <TableHead className="text-right">{t('storage.columnUsed')}</TableHead>
              <TableHead className="@lg:table-cell hidden text-right">
                {t('storage.columnQuota')}
              </TableHead>
              {canManage ? (
                <TableHead className="w-px">
                  <span className="sr-only">{t('storage.columnActions')}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.organizations.map((row) => (
              <StorageRow
                key={row.organizationId}
                row={row}
                canManage={canManage}
                editing={editing === row.organizationId}
                draftGb={draftGb}
                draftError={draftError}
                saving={saving}
                onDraftChange={(value) => {
                  setDraftGb(value)
                  setDraftError(null)
                }}
                onEdit={() => startEdit(row)}
                onCancel={cancelEdit}
                onSubmit={(event) => void submit(event, row.organizationId)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {data.truncated ? (
        <p className="text-muted-foreground text-xs">{t('storage.truncated')}</p>
      ) : null}
      {canManage ? <p className="text-muted-foreground text-xs">{t('storage.hint')}</p> : null}
    </div>
  )
}

interface StorageRowProps {
  row: OrganizationStorageRow
  canManage: boolean
  editing: boolean
  draftGb: string
  draftError: string | null
  saving: boolean
  onDraftChange: (value: string) => void
  onEdit: () => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function StorageRow({
  row,
  canManage,
  editing,
  draftGb,
  draftError,
  saving,
  onDraftChange,
  onEdit,
  onCancel,
  onSubmit,
}: StorageRowProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const name = row.displayName ?? row.organizationId
  const over = row.quotaBytes !== null && row.usedBytes >= row.quotaBytes
  const near =
    !over && row.quotaBytes !== null && row.usedBytes >= row.quotaBytes * NEAR_QUOTA_RATIO
  const quota =
    row.quotaBytes === null ? t('storage.unlimited') : formatBytes(row.quotaBytes, locale)
  const documents = t('storage.rowDocuments', {
    count: row.documents,
    formatted: formatCount(row.documents, locale),
  })

  return (
    <>
      <TableRow className={cn('align-top', editing && 'bg-muted/40 hover:bg-muted/40 border-b-0')}>
        <TableCell className="w-full max-w-0 py-3">
          <div className="truncate font-medium">{name}</div>
          {/* The id, under a name; an organization without a name already shows it. */}
          {row.displayName ? (
            <div className="text-muted-foreground @lg:block hidden truncate font-mono text-xs">
              {row.organizationId}
            </div>
          ) : null}
          <div className="mt-2 max-w-48">
            <QuotaBar usedBytes={row.usedBytes} quotaBytes={row.quotaBytes} />
          </div>
          {over ? (
            <p className="text-destructive mt-1.5 flex items-center gap-1 text-xs">
              <AlertTriangle className="size-3 shrink-0" aria-hidden />
              {t('storage.rowOver')}
            </p>
          ) : null}
          {near ? (
            <p className="text-muted-foreground mt-1.5 flex items-center gap-1 text-xs">
              <AlertTriangle className="size-3 shrink-0" aria-hidden />
              {t('storage.rowNear')}
            </p>
          ) : null}
        </TableCell>
        <TableCell className="py-3 text-right tabular-nums">
          <div className="whitespace-nowrap">{formatBytes(row.usedBytes, locale)}</div>
          <div className="text-muted-foreground @lg:block hidden whitespace-nowrap text-xs">
            {documents}
          </div>
          {/* Narrow: the quota rides under the usage instead of its own column,
              and the document count gives way to it. */}
          <div className="text-muted-foreground @lg:hidden whitespace-nowrap text-xs">
            {row.quotaBytes === null ? quota : t('storage.ofQuota', { quota })}
          </div>
          {row.inherited ? (
            <div className="text-muted-foreground @lg:hidden text-xs">{t('storage.inherited')}</div>
          ) : null}
        </TableCell>
        <TableCell className="@lg:table-cell hidden whitespace-nowrap py-3 text-right tabular-nums">
          {quota}
          {row.inherited ? (
            <div className="text-muted-foreground text-xs">{t('storage.inherited')}</div>
          ) : null}
        </TableCell>
        {canManage ? (
          <TableCell className="py-2.5 pl-0">
            {editing ? null : (
              <Button
                size="icon"
                variant="ghost"
                onClick={onEdit}
                aria-label={t('storage.edit', { org: name })}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
            )}
          </TableCell>
        ) : null}
      </TableRow>
      {editing ? (
        // The editor takes a row of its own under the organization, so it has
        // the width for a field, two actions and an error at every viewport.
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={4} className="pb-3 pt-0">
            <QuotaEditor
              name={name}
              draftGb={draftGb}
              draftError={draftError}
              saving={saving}
              errorId={`quota-error-${row.organizationId}`}
              onDraftChange={onDraftChange}
              onCancel={onCancel}
              onSubmit={onSubmit}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

const QuotaEditor: FC<{
  name: string
  draftGb: string
  draftError: string | null
  saving: boolean
  errorId: string
  onDraftChange: (value: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}> = ({ name, draftGb, draftError, saving, errorId, onDraftChange, onCancel, onSubmit }) => {
  const t = useTranslations('platform')
  return (
    <form className="flex flex-col gap-1.5" onSubmit={onSubmit} data-testid="quota-editor">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-36 flex-none">
          <Input
            autoFocus
            // Text, not `type="number"`: a number input reports anything it
            // cannot parse ("2,5" in an English browser) as an empty value, and
            // empty is how this editor spells UNLIMITED.
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={t('storage.edit', { org: name })}
            aria-invalid={draftError ? true : undefined}
            aria-describedby={draftError ? errorId : undefined}
            placeholder={t('storage.unlimited')}
            className="pr-10 tabular-nums"
            value={draftGb}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // Escape leaves the editor, and must not also close whatever
                // overlay the table might sit in.
                event.preventDefault()
                event.stopPropagation()
                onCancel()
              }
            }}
          />
          <InputGroupAddon align="end" className="right-3">
            <InputGroupText>{t('storage.quotaUnit')}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Spinner size="sm" /> : <Check className="size-4" aria-hidden />}
          {t('storage.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-4" aria-hidden />
          {t('storage.cancel')}
        </Button>
      </div>
      {draftError ? <FieldError id={errorId}>{draftError}</FieldError> : null}
    </form>
  )
}
