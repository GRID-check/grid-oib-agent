'use client'

/**
 * Organisation → Quarantäne: the files the content check held back (ADR-0085),
 * and the two things a reviewer can do with one.
 *
 * The server decides who sees what: an org admin gets the organization's
 * queue, a project admin their projects' part of it, everyone else an empty
 * list. So the page is open to every member and this list never re-derives a
 * permission. Each row says what the file is, where it was uploaded, when, and
 * which rule caught it, in the same phrases the upload summary uses
 * (`describeQuarantineReason`). Detector samples arrive masked from the job.
 *
 * Release sends the file to the models like any other upload, so it asks
 * first. Delete goes through the shelf's own delete route. A row leaves the
 * list only once the server said yes.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FileWarning, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  deleteQuarantinedDocument,
  listQuarantineQueue,
  releaseQuarantinedDocument,
  type QuarantineQueueItem,
} from '@/adapters/api/upload-screening-client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { describeQuarantineReason } from '@/lib/upload-screening/quarantine'

type PendingAction = { kind: 'release' | 'delete'; item: QuarantineQueueItem }

/** Project names for the "where" line. Best-effort: a failed read shows "a project". */
function useProjectNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/projects', { signal: controller.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as { id: string; name: string }[]) : []))
      .then((rows) => setNames(new Map(rows.map((row) => [row.id, row.name]))))
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  return names
}

export const QuarantineQueue: FC = () => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const [items, setItems] = useState<QuarantineQueueItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  // The item stays set while the dialog animates out, so its title does not blank.
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const ask = (action: PendingAction): void => {
    setPending(action)
    setDialogOpen(true)
  }
  const projectNames = useProjectNames()

  const load = useCallback(async (signal?: AbortSignal) => {
    setFailed(false)
    try {
      setItems(await listQuarantineQueue(signal))
    } catch {
      if (!signal?.aborted) setFailed(true)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const drop = (id: string): void => setItems((prev) => prev?.filter((item) => item.id !== id) ?? null)

  const release = async (item: QuarantineQueueItem): Promise<void> => {
    try {
      await releaseQuarantinedDocument(item.id)
      drop(item.id)
      toast.success(t('quarantine.released', { name: item.filename }))
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 409 || error.status === 404)) {
        // Someone else released or deleted it first: the list was stale, not the action wrong.
        toast.error(t('quarantine.changed'))
        void load()
        return
      }
      toast.error(t('quarantine.releaseError'))
    }
  }

  const remove = async (item: QuarantineQueueItem): Promise<void> => {
    try {
      await deleteQuarantinedDocument(item)
      drop(item.id)
      toast.success(t('quarantine.deleted', { name: item.filename }))
    } catch (error) {
      const notInChat = item.scope === 'session' && error instanceof ApiRequestError && error.status === 404
      toast.error(notInChat ? t('quarantine.deleteErrorSession') : t('quarantine.deleteError'))
      void load()
    }
  }

  if (failed) {
    return (
      <EmptyState
        title={t('quarantine.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {tc('actions.retry')}
          </Button>
        }
      />
    )
  }
  if (!items) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={tc('states.loading')}>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title={t('quarantine.empty')}
        description={t('quarantine.emptyHint')}
        data-testid="quarantine-empty"
      />
    )
  }

  return (
    <>
      <ItemList as="ul" aria-label={t('quarantine.listLabel')} data-testid="quarantine-queue">
        {items.map((item) => (
          <QuarantineRow
            key={item.id}
            item={item}
            projectName={item.projectId ? projectNames.get(item.projectId) : undefined}
            onRelease={() => ask({ kind: 'release', item })}
            onDelete={() => ask({ kind: 'delete', item })}
          />
        ))}
      </ItemList>

      <ConfirmDialog
        open={dialogOpen && pending?.kind === 'release'}
        onOpenChange={setDialogOpen}
        title={t('quarantine.releaseTitle', { name: pending?.item.filename ?? '' })}
        description={t('quarantine.releaseDescription')}
        confirmLabel={t('quarantine.release')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        icon={ShieldOff}
        confirmTestId="quarantine-release-confirm"
        onConfirm={async () => {
          if (pending) await release(pending.item)
        }}
      />
      <ConfirmDialog
        open={dialogOpen && pending?.kind === 'delete'}
        onOpenChange={setDialogOpen}
        title={t('quarantine.deleteTitle', { name: pending?.item.filename ?? '' })}
        description={t('quarantine.deleteDescription')}
        confirmLabel={t('quarantine.delete')}
        cancelLabel={tc('actions.cancel')}
        tone="destructive"
        icon={Trash2}
        confirmTestId="quarantine-delete-confirm"
        onConfirm={async () => {
          if (pending) await remove(pending.item)
        }}
      />
    </>
  )
}

const QuarantineRow: FC<{
  item: QuarantineQueueItem
  projectName: string | undefined
  onRelease: () => void
  onDelete: () => void
}> = ({ item, projectName, onRelease, onDelete }) => {
  const t = useTranslations('organization')
  // The reason phrases live with the upload summary's, in `files.screening.*`.
  const tFiles = useTranslations('files')
  const { locale } = useLocale()
  const reasons = useMemo(
    () => (item.verdict?.reasons ?? []).map((reason) => describeQuarantineReason(reason, tFiles)),
    [item.verdict, tFiles]
  )

  const where =
    item.scope === 'archiv'
      ? t('quarantine.whereArchiv')
      : item.scope === 'session'
        ? t('quarantine.whereSession')
        : projectName
          ? t('quarantine.whereProject', { name: projectName })
          : t('quarantine.whereProjectUnknown')

  return (
    <Item as="li" className="flex-wrap items-start hover:bg-transparent" data-testid={`quarantine-row-${item.id}`}>
      <ItemMedia>
        <FileWarning className="size-5 text-warning" aria-hidden />
      </ItemMedia>
      <ItemContent className="flex flex-col gap-1.5">
        <ItemTitle title={item.filename}>{item.filename}</ItemTitle>
        <ItemDescription>
          {where} · <TimeAgo date={item.quarantinedAt} locale={locale} />
        </ItemDescription>
        {reasons.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('quarantine.reasonsLabel')}>
            {reasons.map((reason, index) => (
              <li key={`${index}-${reason}`} className="max-w-full">
                <Chip variant="warning" className="max-w-full">
                  <span className="truncate">{reason}</span>
                </Chip>
              </li>
            ))}
          </ul>
        ) : (
          <ItemDescription>{t('quarantine.noReason')}</ItemDescription>
        )}
        {item.verdict?.checked === 'partial' && (
          // A sentence, not a label: it wraps instead of truncating on a phone.
          <ItemDescription className="whitespace-normal">{tFiles('screening.partial')}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions className="w-full justify-end sm:w-auto">
        <Button variant="outline" size="sm" onClick={onRelease} data-testid={`quarantine-release-${item.id}`}>
          {t('quarantine.release')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} data-testid={`quarantine-delete-${item.id}`}>
          <Trash2 className="size-4" aria-hidden />
          {t('quarantine.delete')}
        </Button>
      </ItemActions>
    </Item>
  )
}
