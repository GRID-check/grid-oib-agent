'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  FilePlus2,
  FolderInput,
  FolderPlus,
  MoveRight,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CountPill } from '@/components/ui/count-pill'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { StatCardIcon, type StatCardIconTone } from '@/components/ui/stat-card'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  countPlan,
  type FolderUploadPlan,
  type PlannedAction,
  type PlannedFile,
} from '../lib/folder-upload-plan'

/**
 * „Wollen Sie aktualisieren?" — asked once, with the answer visible.
 *
 * A folder upload is the one gesture in this product that can quietly change
 * work somebody else did. It replaces documents by name, re-files them into the
 * folders the tree implies, and — before this dialog existed — did all of that
 * the moment the picker closed, with no statement of what it was about to
 * touch. A person dropping a fortnight's worth of an Einreichung had no way to
 * find out whether they were adding eight files or overwriting five hundred.
 *
 * So the plan is shown BEFORE anything moves, and the one decision that
 * actually changes the outcome — update the documents that already exist, or
 * add only what is new — is a checkbox rather than a second dialog. Everything
 * else on this surface is a statement, not a question: which folders were
 * matched, which will be created, what is being skipped because the bytes are
 * identical, and which files the project cannot hold two of.
 *
 * The counts are the headline because they are what the answer turns on. The
 * lists are there because a count without names is not something a person can
 * check, and they are collapsed because five hundred rows is not a summary.
 */
export interface FolderUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null while the drop is still being read and hashed. */
  plan: FolderUploadPlan | null
  /** The folder the reader is standing in, named. Null is the project root. */
  currentFolderName: string | null
  /** Confirm. `includeUpdates` is the reader's answer to the one question. */
  onConfirm: (includeUpdates: boolean) => void | Promise<void>
  /** In flight — the plan is being applied (folders created, files queued). */
  pending?: boolean
}

export function FolderUploadDialog({
  open,
  onOpenChange,
  plan,
  currentFolderName,
  onConfirm,
  pending = false,
}: FolderUploadDialogProps): JSX.Element {
  const t = useTranslations('files')
  /**
   * Default ON.
   *
   * The gesture is "bring this folder in", and a reader who dragged a corrected
   * set across expects the corrections to land. Defaulting to off would make the
   * common case a silent no-op that looks like a successful upload — the worse
   * of the two ways to be wrong, because nothing on screen afterwards would say
   * the new plans are not here.
   */
  const [includeUpdates, setIncludeUpdates] = useState(true)

  /**
   * A new drop starts from the default again.
   *
   * The dialog is mounted for the life of the page, so without this the answer
   * given to one folder would silently decide the next one — a reader who
   * declined the updates in a Statik folder in the morning would find the
   * afternoon's corrected drawings quietly not uploaded. Keyed off `plan`
   * becoming null, which is what every new drop does before it has a plan.
   */
  useEffect(() => {
    if (!plan) setIncludeUpdates(true)
  }, [plan])

  const counts = useMemo(
    () => (plan ? countPlan(plan.files, plan.folders, includeUpdates) : null),
    [plan, includeUpdates],
  )

  const destination = currentFolderName ?? t('folders.allFiles')

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg" aria-busy={pending || undefined} data-testid="folder-upload-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3.5">
            <StatCardIcon icon={FolderInput} tone="info" />
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>
                {plan?.rootName
                  ? t('folderUpload.title', { name: plan.rootName })
                  : t('folderUpload.titleGeneric')}
              </DialogTitle>
              <DialogDescription>
                {plan?.mergedIntoCurrentFolder
                  ? t('folderUpload.destinationMerged', { folder: destination })
                  : t('folderUpload.destination', { folder: destination })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!plan || !counts ? (
          // Reading the tree and hashing the plausible duplicates. Named rather
          // than left as a bare spinner: on a large folder this is seconds long
          // and "comparing with what is already here" is exactly what it is
          // doing.
          <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground" data-testid="folder-upload-planning">
            <Spinner size="sm" />
            {t('folderUpload.planning')}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <PlanCount
                icon={FilePlus2}
                tone="success"
                count={counts.new}
                label={t('folderUpload.counts.new')}
                testId="folder-upload-count-new"
              />
              <PlanCount
                icon={RefreshCw}
                tone="warning"
                count={counts.update}
                label={t('folderUpload.counts.update')}
                testId="folder-upload-count-update"
              />
              <PlanCount
                icon={ShieldCheck}
                tone="muted"
                count={counts.unchanged}
                label={t('folderUpload.counts.unchanged')}
                testId="folder-upload-count-unchanged"
              />
              <PlanCount
                icon={FolderPlus}
                tone="info"
                count={counts.foldersCreated}
                label={t('folderUpload.counts.foldersCreated')}
                testId="folder-upload-count-folders"
                // The other half of the folder story, and the half that says the
                // matching worked: a re-sync creates nothing and matches
                // everything.
                secondary={
                  counts.foldersMatched > 0
                    ? t('folderUpload.counts.foldersMatched', { count: String(counts.foldersMatched) })
                    : undefined
                }
              />
            </div>

            {counts.update > 0 && (
              <label
                className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/40 p-3"
                data-testid="folder-upload-include-updates"
              >
                <Checkbox
                  checked={includeUpdates}
                  onCheckedChange={(checked) => setIncludeUpdates(checked === true)}
                  disabled={pending}
                  aria-label={t('folderUpload.updatePrompt', { count: String(counts.update) })}
                />
                <span className="min-w-0 space-y-1 text-sm">
                  <span className="block font-medium text-foreground">
                    {t('folderUpload.updatePrompt', { count: String(counts.update) })}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('folderUpload.updateExplain')}
                  </span>
                </span>
              </label>
            )}

            {/* A re-file is the part of an update a reader does not see coming:
                the document exists, it is simply filed somewhere else, and the
                upload moves it to where the tree puts it. */}
            {counts.refiled > 0 && (
              <Alert data-testid="folder-upload-refiled">
                <MoveRight aria-hidden />
                <AlertDescription>
                  {t('folderUpload.refiled', { count: String(counts.refiled) })}
                </AlertDescription>
              </Alert>
            )}

            {/* THE ONE THING THAT IS NOT MERELY INFORMATION.
                A project holds one document per filename, so two files of the
                same name inside one drop cannot both land — and before this
                they both uploaded, one overwriting the other, with nothing said.
                Neither is sent; the reader is told which, so they can rename or
                pick. */}
            {counts.collision > 0 && (
              <Alert variant="warning" data-testid="folder-upload-collisions">
                <AlertTriangle aria-hidden />
                <AlertTitle>
                  {t('folderUpload.collisions', { count: String(counts.collision) })}
                </AlertTitle>
                <AlertDescription className="space-y-1">
                  <span className="block">{t('folderUpload.collisionsExplain')}</span>
                  <FileNameList files={plan.files.filter((file) => file.action === 'collision')} />
                </AlertDescription>
              </Alert>
            )}

            <PlanDetails plan={plan} includeUpdates={includeUpdates} />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('folderUpload.cancel')}
          </Button>
          <Button
            onClick={() => void onConfirm(includeUpdates)}
            // Nothing to send is not a reason to hide the dialog's answer — the
            // reader still wants to read "everything here is already up to
            // date" — but it is a reason not to offer an upload button that
            // would do nothing.
            disabled={pending || !counts || counts.uploading === 0}
            data-testid="folder-upload-confirm"
          >
            {pending && <Spinner size="sm" />}
            {counts && counts.uploading > 0
              ? t('folderUpload.confirm', { count: String(counts.uploading) })
              : t('folderUpload.nothingToDo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One number, its glyph and what it means.
 *
 * `StatCard` is the kit's stat tile and is the wrong size here: `p-5` and a
 * `text-2xl` figure, four of them, inside a dialog that also has to hold a
 * decision and a file list. Its icon slot also wraps whatever it is given in a
 * fixed muted disc, so a toned glyph would be a disc inside a disc. The atom
 * that matters — the tinted well — IS the kit's (`StatCardIcon`); what is local
 * is the cell around it, which is layout.
 */
function PlanCount({
  icon,
  tone,
  count,
  label,
  secondary,
  testId,
}: {
  icon: LucideIcon
  tone: StatCardIconTone
  count: number
  label: string
  secondary?: string
  testId: string
}): JSX.Element {
  return (
    <div
      className={cn('flex items-center gap-2.5 rounded-lg border p-2.5', count === 0 && 'opacity-55')}
      data-testid={testId}
    >
      <StatCardIcon icon={icon} tone={tone} size="sm" />
      <div className="min-w-0">
        <p className="text-sm font-semibold tabular-nums text-foreground">{count}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        {secondary && <p className="truncate text-[11px] text-muted-foreground/80">{secondary}</p>}
      </div>
    </div>
  )
}


/** Names, because a count nobody can check is a number to be believed. */
function FileNameList({ files }: { files: readonly PlannedFile[] }): JSX.Element {
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {files.slice(0, 6).map((file) => (
        <li key={file.originPath} className="truncate font-mono opacity-90">
          {file.originPath}
        </li>
      ))}
      {files.length > 6 && <li className="opacity-70">+{files.length - 6}</li>}
    </ul>
  )
}

/**
 * The whole plan, file by file, behind a disclosure.
 *
 * Collapsed because a summary that is five hundred rows long is not a summary,
 * and open-able because a person about to replace somebody's drawings is
 * entitled to see exactly which ones. `<details>` rather than a Collapsible:
 * nothing here needs to animate, and the native element keeps its keyboard and
 * screen-reader behaviour for free.
 */
function PlanDetails({
  plan,
  includeUpdates,
}: {
  plan: FolderUploadPlan
  includeUpdates: boolean
}): JSX.Element | null {
  const t = useTranslations('files')
  const rows = plan.files
  if (rows.length === 0) return null

  return (
    <details className="rounded-lg border" data-testid="folder-upload-details">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-foreground">
        {t('folderUpload.showAll', { count: String(rows.length) })}
      </summary>
      <ScrollArea className="max-h-56">
        <ul className="space-y-0.5 px-3 pb-3">
          {rows.map((file) => (
            <li key={file.originPath} className="flex items-center gap-2 text-xs">
              <ActionTag action={file.action} includeUpdates={includeUpdates} />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {file.originPath}
              </span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </details>
  )
}

/** What this row will do, in one word. */
function ActionTag({
  action,
  includeUpdates,
}: {
  action: PlannedAction
  includeUpdates: boolean
}): JSX.Element {
  const t = useTranslations('files')
  // An update the reader has switched off is skipped, and the row has to say
  // so — a list still labelled „Aktualisieren" under an unticked box describes
  // an upload that is not going to happen.
  const effective = action === 'update' && !includeUpdates ? 'skipped' : action
  const label = t(`folderUpload.action.${effective}`)
  return (
    <CountPill tone={effective === 'new' || effective === 'update' ? 'attention' : 'muted'}>
      {label}
    </CountPill>
  )
}
