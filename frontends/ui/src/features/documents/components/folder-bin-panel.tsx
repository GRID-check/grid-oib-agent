'use client'

/**
 * A project's Papierkorb (ADR-0085): the folders deleted in it, who deleted
 * each and when, when its purge runs, and what the reader may do — restore
 * (with its access, its subfolders and documents), and „Endgültig löschen"
 * for project admins.
 *
 * Only folders the reader may read are listed; the server filters, and checks
 * every action again.
 */

import { useCallback, useState, type JSX } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, Folder, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  FolderBinRequestError,
  listFolderBin,
  purgeFolderNow,
  restoreFolder,
  type FolderBinEntry,
  type FolderBinListing,
} from '@/adapters/api/folder-bin-client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { PageHeader } from '@/components/ui/page-header'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate } from '@/lib/format'

export interface FolderBinPanelProps {
  projectId: string
  /** The listing the page read on the server; the panel re-reads after every action. */
  initial: FolderBinListing | null
}

export function FolderBinPanel({ projectId, initial }: FolderBinPanelProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [listing, setListing] = useState<FolderBinListing | null>(initial)
  const [loadFailed, setLoadFailed] = useState(initial === null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [purging, setPurging] = useState<FolderBinEntry | null>(null)

  const date = (iso: string): string => formatCalendarDate(iso, locale)

  const reload = useCallback(async () => {
    try {
      setListing(await listFolderBin(projectId))
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [projectId])

  const restore = async (entry: FolderBinEntry): Promise<void> => {
    setBusyId(entry.folderId)
    try {
      const restored = await restoreFolder(projectId, entry.folderId)
      toast.success(
        restored.restoredTo === 'root'
          ? t('bin.restoredToRoot', { name: entry.name })
          : t('bin.restored', { name: entry.name })
      )
      await reload()
    } catch (error) {
      const reason = error instanceof FolderBinRequestError ? error.reason : null
      toast.error(
        reason === 'folder-name-taken'
          ? t('bin.restoreNameTaken', { name: entry.name })
          : reason === 'folder-read-only'
            ? t('bin.restoreReadOnly')
            : t('bin.restoreError')
      )
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (): Promise<void> => {
    if (!purging) return
    const entry = purging
    try {
      await purgeFolderNow(projectId, entry.folderId)
      toast.success(t('bin.purged', { name: entry.name }))
      await reload()
    } catch (error) {
      const held = error instanceof FolderBinRequestError && error.reason === 'legal_hold'
      toast.error(held ? t('bin.held') : t('bin.purgeError'))
      throw error
    }
  }

  const header = (
    <PageHeader
      title={t('bin.title')}
      subtitle={t('bin.subtitle')}
      action={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/app/projects/${projectId}/files`}>
            <ArrowLeft className="size-4" aria-hidden />
            {t('bin.back')}
          </Link>
        </Button>
      }
    />
  )

  if (loadFailed || !listing) {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        {header}
        <EmptyState
          icon={AlertTriangle}
          tone="destructive"
          title={t('bin.loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('bin.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6" data-testid="folder-bin">
      {header}
      {listing.entries.length === 0 ? (
        <EmptyState icon={Trash2} title={t('bin.empty')} description={t('bin.emptyHint')} />
      ) : (
        <ItemList as="ul">
          {listing.entries.map((entry) => (
            // On a phone the actions take their own line under the entry,
            // rather than squeezing its name and dates to nothing.
            <Item key={entry.folderId} as="li" className="flex-wrap sm:flex-nowrap" data-testid={`bin-entry-${entry.folderId}`}>
              <ItemMedia>
                <Folder className="text-muted-foreground size-5" aria-hidden />
              </ItemMedia>
              <ItemContent className="basis-[calc(100%-2.75rem)] sm:basis-auto">
                <ItemTitle title={entry.path}>{entry.name}</ItemTitle>
                <ItemDescription>
                  {entry.deletedBy.name
                    ? t('bin.deletedBy', { name: entry.deletedBy.name, date: date(entry.deletedAt) })
                    : t('bin.deletedOn', { date: date(entry.deletedAt) })}
                  {' · '}
                  {t('bin.contents', { documents: entry.documents, folders: entry.folders })}
                </ItemDescription>
                <ItemDescription>
                  {entry.status === 'purging'
                    ? t('bin.purging')
                    : entry.status === 'failed'
                      ? t('bin.failed')
                      : t('bin.purgeOn', { date: date(entry.purgeAfter) })}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="w-full flex-wrap justify-end sm:w-auto sm:flex-nowrap">
                {entry.canRestore && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === entry.folderId}
                    onClick={() => void restore(entry)}
                    data-testid={`bin-restore-${entry.folderId}`}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t('bin.restore')}
                  </Button>
                )}
                {listing.canPurge && entry.status !== 'purging' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setPurging(entry)}
                    data-testid={`bin-purge-${entry.folderId}`}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('bin.purge')}
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemList>
      )}

      <ConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => (open ? undefined : setPurging(null))}
        title={t('bin.purgeTitle', { name: purging?.name ?? '' })}
        description={t('bin.purgeDescription', { documents: purging?.documents ?? 0 })}
        confirmLabel={t('bin.purge')}
        cancelLabel={t('bin.cancel')}
        onConfirm={purge}
        confirmTestId="bin-purge-confirm"
      />
    </div>
  )
}
