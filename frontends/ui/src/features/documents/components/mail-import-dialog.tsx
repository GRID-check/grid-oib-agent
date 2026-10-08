'use client'

/**
 * Import an Outlook archive into the project (ADR-0085): choose a .pst or .ost,
 * watch it go up, then follow the imports of this project as the background
 * job files them.
 *
 * The dialog is only the sending half's home. Closing it does not stop a send,
 * and the filing never needed it: the row says where things stand when it is
 * opened again, and the inbox says when an import ends.
 */

import type { JSX } from 'react'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, Mail, Upload, XCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { StatCardIcon } from '@/components/ui/stat-card'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { MAIL_ARCHIVE_EXTENSIONS } from '@/lib/mail-import/config'
import type { MailImportView } from '@/lib/mail-import/types'
import { useMailImports, type UseMailImports } from '../hooks/use-mail-imports'

type Translate = ReturnType<typeof useTranslations>

const STATUS_BADGE: Record<MailImportView['status'], 'info' | 'secondary' | 'success' | 'destructive' | 'outline'> = {
  uploading: 'info',
  queued: 'secondary',
  importing: 'info',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'outline',
}

const SAMPLES_SHOWN = 3

export interface MailImportDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MailImportDialog({ projectId, open, onOpenChange }: MailImportDialogProps): JSX.Element {
  const state = useMailImports(projectId, open)
  return <MailImportDialogView projectId={projectId} open={open} onOpenChange={onOpenChange} state={state} />
}

/** The dialog over a given state: what the `/dev/mail-import` preview renders with fixtures. */
export function MailImportDialogView({
  projectId,
  open,
  onOpenChange,
  state,
}: MailImportDialogProps & { state: UseMailImports }): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const inputRef = useRef<HTMLInputElement>(null)
  const [resumeTarget, setResumeTarget] = useState<MailImportView | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const maxSize = state.list?.maxSizeBytes ?? null

  const choose = (target: MailImportView | null) => {
    setResumeTarget(target)
    setPickError(null)
    inputRef.current?.click()
  }

  const onPicked = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    const refusal = pickRefusal(t, locale, file, maxSize, resumeTarget)
    if (refusal) {
      setPickError(refusal)
      return
    }
    void (resumeTarget ? state.resume(resumeTarget, file) : state.start(file))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="mail-import-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3.5">
            <StatCardIcon icon={Mail} tone="info" />
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>{t('mailImport.title')}</DialogTitle>
              <DialogDescription>{t('mailImport.description')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept={MAIL_ARCHIVE_EXTENSIONS.join(',')}
          className="hidden"
          data-testid="mail-import-input"
          onChange={(event) => onPicked(event.target.files?.[0])}
        />

        <Alert variant="info">
          <AlertDescription>{t('mailImport.privacy')}</AlertDescription>
        </Alert>

        {state.sending ? (
          <div className="space-y-2" data-testid="mail-import-sending">
            <p className="text-sm font-medium">{state.sending.filename}</p>
            <Progress value={(state.sending.sentBytes / Math.max(1, state.sending.totalBytes)) * 100} />
            <p className="text-sm text-muted-foreground">
              {t('mailImport.sending', {
                sent: formatBytes(state.sending.sentBytes, locale),
                total: formatBytes(state.sending.totalBytes, locale),
              })}{' '}
              {t('mailImport.sendingHint')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => choose(null)} className="gap-2" data-testid="mail-import-choose">
              <Upload className="size-4" aria-hidden />
              {t('mailImport.choose')}
            </Button>
            {maxSize !== null && (
              <span className="text-sm text-muted-foreground">
                {t('mailImport.maxSize', { size: formatBytes(maxSize, locale) })}
              </span>
            )}
          </div>
        )}

        {(pickError || state.sendError) && (
          <Alert variant="destructive" data-testid="mail-import-error">
            <AlertTriangle aria-hidden />
            <AlertDescription>
              {pickError ?? t('mailImport.sendError', { reason: state.sendError ?? '' })}
            </AlertDescription>
          </Alert>
        )}

        <section className="space-y-2">
          <SectionLabel>{t('mailImport.history')}</SectionLabel>
          <ImportList
            projectId={projectId}
            state={state}
            onResume={(row) => choose(row)}
            t={t}
            locale={locale}
          />
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('mailImport.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportList({
  projectId,
  state,
  onResume,
  t,
  locale,
}: {
  projectId: string
  state: UseMailImports
  onResume: (row: MailImportView) => void
  t: Translate
  locale: string
}): JSX.Element {
  if (state.loadError) return <EmptyState variant="bare" title={t('mailImport.loadError')} />
  if (!state.list) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size="sm" />
      </div>
    )
  }
  if (state.list.imports.length === 0) return <EmptyState variant="bare" title={t('mailImport.empty')} />
  return (
    <ItemList as="ul" data-testid="mail-import-list">
      {state.list.imports.map((row) => (
        <ImportRow
          key={row.id}
          projectId={projectId}
          row={row}
          sendingThis={state.sending?.importId === row.id}
          onResume={() => onResume(row)}
          onCancel={() => void state.cancel(row)}
          t={t}
          locale={locale}
        />
      ))}
    </ItemList>
  )
}

function ImportRow({
  projectId,
  row,
  sendingThis,
  onResume,
  onCancel,
  t,
  locale,
}: {
  projectId: string
  row: MailImportView
  sendingThis: boolean
  onResume: () => void
  onCancel: () => void
  t: Translate
  locale: string
}): JSX.Element {
  const open = row.status === 'uploading' || row.status === 'queued' || row.status === 'importing'
  const resumable = row.status === 'uploading' && row.ownedByViewer && !sendingThis
  const total = row.totalItems
  return (
    <Item as="li" data-testid="mail-import-row" data-status={row.status}>
      <ItemMedia>
        <StatusIcon status={row.status} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <span className="truncate">{row.filename}</span>
          <Badge variant={STATUS_BADGE[row.status]}>{t(`mailImport.status.${row.status}`)}</Badge>
        </ItemTitle>
        <ItemDescription>
          {formatBytes(row.sizeBytes, locale)}
          {' · '}
          {row.status === 'importing' && total !== null
            ? t('mailImport.progress', { done: row.processedItems, total })
            : t('mailImport.filed', { mails: row.mailsFiled, files: row.filesFiled })}
          {row.itemsSkipped + row.filesSkipped > 0 &&
            ` · ${t('mailImport.skipped', { count: row.itemsSkipped + row.filesSkipped })}`}
          {!row.ownedByViewer && row.startedBy.email && ` · ${t('mailImport.startedBy', { email: row.startedBy.email })}`}
        </ItemDescription>
        {row.status === 'importing' && total ? (
          <Progress className="mt-2" value={(row.processedItems / total) * 100} />
        ) : null}
        {row.errorCode && (
          <p className="mt-1 text-xs break-words text-destructive">
            {t(`mailImport.errors.${row.errorCode}`)}
            {row.errorCode === 'stopped' && row.error ? ` (${row.error})` : ''}
          </p>
        )}
        {resumable && <p className="mt-1 text-xs text-muted-foreground">{t('mailImport.resumeHint', { name: row.filename })}</p>}
        <SkippedSamples row={row} t={t} />
      </ItemContent>
      <ItemActions>
        {row.folderId && (
          <Button asChild size="sm" variant="ghost" className="gap-1.5">
            <Link href={`/app/projects/${projectId}/files?folder=${encodeURIComponent(row.folderId)}`}>
              <FolderOpen className="size-3.5" aria-hidden />
              {t('mailImport.openFolder')}
            </Link>
          </Button>
        )}
        {resumable && (
          <Button size="sm" variant="outline" onClick={onResume} data-testid="mail-import-resume">
            {t('mailImport.resume')}
          </Button>
        )}
        {open && row.ownedByViewer && (
          <Button size="sm" variant="ghost" onClick={onCancel} data-testid="mail-import-cancel">
            {t('mailImport.cancel')}
          </Button>
        )}
      </ItemActions>
    </Item>
  )
}

function SkippedSamples({ row, t }: { row: MailImportView; t: Translate }): JSX.Element | null {
  const shown = row.skippedSamples.filter((sample) => sample.reason !== 'not_mail').slice(0, SAMPLES_SHOWN)
  if (shown.length === 0) return null
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {shown.map((sample, index) => {
        const reason = t(`mailImport.reasons.${sample.reason}`)
        return (
          <li key={`${sample.mail}-${sample.file ?? ''}-${index}`} className="truncate">
            {sample.file
              ? t('mailImport.skippedItem', { file: sample.file, mail: sample.mail, reason })
              : t('mailImport.skippedMail', { mail: sample.mail, reason })}
          </li>
        )
      })}
    </ul>
  )
}

function StatusIcon({ status }: { status: MailImportView['status'] }): JSX.Element {
  if (status === 'completed') return <CheckCircle2 className="size-4 text-success" aria-hidden />
  if (status === 'failed') return <XCircle className="size-4 text-destructive" aria-hidden />
  if (status === 'cancelled') return <XCircle className="size-4 text-muted-foreground" aria-hidden />
  return <Loader2 className="size-4 animate-spin text-info motion-reduce:animate-none" aria-hidden />
}

/** Why a picked file cannot be sent, or null. */
function pickRefusal(
  t: Translate,
  locale: string,
  file: File,
  maxSize: number | null,
  resumeTarget: MailImportView | null,
): string | null {
  if (resumeTarget && (file.name !== resumeTarget.filename || file.size !== resumeTarget.sizeBytes)) {
    return t('mailImport.resumeMismatch', {
      name: resumeTarget.filename,
      size: formatBytes(resumeTarget.sizeBytes, locale),
    })
  }
  const lower = file.name.toLowerCase()
  if (!MAIL_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return t('mailImport.notAnArchive', { name: file.name })
  }
  if (maxSize !== null && file.size > maxSize) {
    return t('mailImport.tooLarge', { name: file.name, size: formatBytes(maxSize, locale) })
  }
  return null
}
