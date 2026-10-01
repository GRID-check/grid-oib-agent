'use client'

import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  FilePlus2,
  FolderInput,
  FolderPlus,
  MoveRight,
  RefreshCw,
  ShieldAlert,
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
import type { UploadDecisionKind } from '../hooks/use-upload-decision'
import { describeNameMatch } from '@/lib/upload-screening/quarantine'

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
 * identical, which documents move because the tree files them elsewhere, which
 * files the project already holds under another name, and which files it cannot
 * hold two of.
 *
 * Where a document has been renamed here, the row carries BOTH names. The plan
 * speaks in the names the drop uses and the corpus speaks in the names people
 * gave it; asking somebody to approve replacing a document they cannot find in
 * their own file list is not asking.
 *
 * The counts are the headline because they are what the answer turns on. The
 * lists are there because a count without names is not something a person can
 * check, and they are collapsed because five hundred rows is not a summary.
 *
 * Loose FILES come through here too (`kind: 'files'`), but only when one of
 * them would touch a document that is already on the shelf — a same-name
 * upload makes a new version of the live document (ADR-0054), and that is the
 * same question a folder asks about each of its files. One such file gets the
 * question in its own words: „Neue Fassung von „X“ hochladen?", or, when the
 * bytes are identical, „Unverändert – bereits vorhanden".
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
  /** A dropped or picked folder, or loose files that met existing documents. */
  kind?: UploadDecisionKind
  /**
   * The reader's answer for one file the upload screening held back
   * (ADR-0077). Absent: the exclusions are listed without a way to release.
   */
  onReleaseChange?: (file: File, released: boolean) => void
}

export function FolderUploadDialog({
  open,
  onOpenChange,
  plan,
  currentFolderName,
  onConfirm,
  pending = false,
  kind = 'folder',
  onReleaseChange,
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
  const isFolder = kind === 'folder'
  /**
   * One loose file that is already here, new bytes or the same ones: asked in
   * its own words, without the counts a batch needs.
   */
  const single =
    !isFolder && plan?.files.length === 1 && (plan.files[0].action === 'update' || plan.files[0].action === 'unchanged')
      ? plan.files[0]
      : null
  const singleName = single ? single.file.name : ''
  const singleShownAs = single ? (single.existingName ?? single.file.name) : ''
  const singleMoves = single?.refiledFromFolderId !== undefined

  const title = single
    ? single.action === 'update'
      ? t('folderUpload.single.updateTitle', { name: singleName })
      : t('folderUpload.single.unchangedTitle')
    : isFolder
      ? plan?.rootName
        ? t('folderUpload.title', { name: plan.rootName })
        : t('folderUpload.titleGeneric')
      : plan
        ? t('folderUpload.titleFiles', { count: plan.files.length })
        : t('folderUpload.titleFilesGeneric')
  const description = single
    ? single.action === 'update'
      ? t('folderUpload.single.updateExplain', { name: singleShownAs })
      : t('folderUpload.single.unchangedExplain', { name: singleShownAs })
    : isFolder
      ? plan?.mergedIntoCurrentFolder
        ? t('folderUpload.destinationMerged', { folder: destination })
        : t('folderUpload.destination', { folder: destination })
      : t('folderUpload.destinationFiles', { folder: destination })
  const HeaderIcon = single ? (single.action === 'update' ? RefreshCw : ShieldCheck) : isFolder ? FolderInput : FilePlus2
  const nothingToDo = !counts || counts.uploading + counts.moving === 0

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-lg"
        aria-busy={pending || undefined}
        data-testid="folder-upload-dialog"
        data-kind={single ? `single-${single.action}` : kind}
      >
        <DialogHeader>
          <div className="flex items-start gap-3.5">
            <StatCardIcon icon={HeaderIcon} tone={single?.action === 'unchanged' ? 'muted' : 'info'} />
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
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
        ) : single ? (
          // The one file already says everything in the title; what is left is
          // where the document ends up, when that is not where it is now — and
          // that it is archived, because the new version stays out of sight
          // with it.
          singleMoves || single.existingArchived ? (
            <div className="space-y-2">
              {single.existingArchived && (
                <Alert data-testid="folder-upload-archived">
                  <AlertDescription>{t('folderUpload.single.archived')}</AlertDescription>
                </Alert>
              )}
              {singleMoves && (
                <Alert data-testid="folder-upload-refiled">
                  <MoveRight aria-hidden />
                  <AlertDescription>{t('folderUpload.single.refiled', { folder: destination })}</AlertDescription>
                </Alert>
              )}
            </div>
          ) : null
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
              {isFolder && (
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
              )}
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

            {/* Where documents END UP, which is the part a reader does not see
                coming: the document exists, it is simply filed somewhere else,
                and this drop puts it where its tree says it belongs. */}
            {(counts.refiled > 0 || counts.moving > 0) && (
              <Alert data-testid="folder-upload-refiled">
                <MoveRight aria-hidden />
                <AlertDescription className="space-y-1">
                  {counts.refiled > 0 && (
                    <span className="block">
                      {t('folderUpload.refiled', { count: String(counts.refiled) })}
                    </span>
                  )}
                  {/* The unchanged ones send no bytes, so nothing about the
                      upload would move them — they are moved on their own, and
                      that is a different sentence. */}
                  {counts.moving > 0 && (
                    <span className="block">
                      {t('folderUpload.moving', { count: String(counts.moving) })}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* ALREADY HERE UNDER ANOTHER NAME.
                Not an update — the server replaces by filename and these do not
                share one, so uploading would add a second copy of a document
                the project already holds. Named with what it is called here,
                because that is the only way the reader can go and look. */}
            {counts.duplicate > 0 && (
              <Alert variant="warning" data-testid="folder-upload-duplicates">
                <Copy aria-hidden />
                <AlertTitle>
                  {t('folderUpload.duplicates', { count: String(counts.duplicate) })}
                </AlertTitle>
                <AlertDescription className="space-y-1">
                  <span className="block">{t('folderUpload.duplicatesExplain')}</span>
                  <FileNameList files={plan.files.filter((file) => file.action === 'duplicate')} />
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

            <ScreeningSection plan={plan} pending={pending} onReleaseChange={onReleaseChange} />

            <PlanDetails plan={plan} includeUpdates={includeUpdates} />
          </div>
        )}

        <DialogFooter>
          {single && nothingToDo ? (
            // Identical and already where it belongs: a statement, so one way out.
            <Button onClick={() => onOpenChange(false)} data-testid="folder-upload-close">
              {t('folderUpload.close')}
            </Button>
          ) : (
          <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('folderUpload.cancel')}
          </Button>
          <Button
            // The one file's question IS the update question, so its button answers yes.
            onClick={() => void onConfirm(single ? true : includeUpdates)}
            /*
             * Nothing to send is not a reason to hide the dialog's answer — the
             * reader still wants to read "everything here is already up to
             * date" — but it is a reason not to offer a button that would do
             * nothing.
             *
             * "Nothing" includes the moves. A re-sync of a folder somebody has
             * since reorganised in Piloti uploads not one byte and still has
             * work to do, and a disabled button there would say the tree is
             * already reproduced when it is not.
             */
            disabled={pending || nothingToDo}
            data-testid="folder-upload-confirm"
          >
            {pending && <Spinner size="sm" />}
            {nothingToDo
              ? t('folderUpload.nothingToDo')
              : single?.action === 'update'
                ? t('folderUpload.single.confirmUpdate')
                : (counts?.uploading ?? 0) > 0
                  ? t('folderUpload.confirm', { count: String(counts?.uploading ?? 0) })
                  : t('folderUpload.confirmMoveOnly', { count: String(counts?.moving ?? 0) })}
          </Button>
          </>
          )}
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


/**
 * What the office's upload screening held back, and why (ADR-0077).
 *
 * A statement and a question at once: these files stay on this computer, and
 * each one can be released by the person who knows what it is — the Bauvertrag
 * in a folder called „Verträge". A released file stays in the list, ticked, so
 * the release can be taken back before anything is sent.
 */
function ScreeningSection({
  plan,
  pending,
  onReleaseChange,
}: {
  plan: FolderUploadPlan
  pending: boolean
  onReleaseChange?: (file: File, released: boolean) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const screened = plan.files.filter((file) => file.action === 'excluded' || file.screeningReleased)
  if (screened.length === 0) return null
  const excludedCount = screened.filter((file) => file.action === 'excluded').length
  return (
    <Alert variant="warning" data-testid="folder-upload-excluded">
      <ShieldAlert aria-hidden />
      <AlertTitle>{t('folderUpload.excluded', { count: String(excludedCount) })}</AlertTitle>
      <AlertDescription className="space-y-2">
        <span className="block">{t('folderUpload.excludedExplain')}</span>
        <ul className="space-y-1.5 text-xs">
          {screened.slice(0, 20).map((file, index) => (
            <li key={`${index}:${file.originPath}`} className="flex items-start gap-2">
              {onReleaseChange && (
                <Checkbox
                  checked={file.screeningReleased === true}
                  onCheckedChange={(checked) => onReleaseChange(file.file, checked === true)}
                  disabled={pending}
                  aria-label={`${t('folderUpload.releaseFile')}: ${file.originPath}`}
                  data-testid="folder-upload-release"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{file.originPath}</span>
                <span className="block opacity-80">
                  {(file.screening ?? []).map((match) => describeNameMatch(match, t)).join(' · ')}
                </span>
              </span>
            </li>
          ))}
          {screened.length > 20 && <li className="opacity-70">+{screened.length - 20}</li>}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** Names, because a count nobody can check is a number to be believed. */
function FileNameList({ files }: { files: readonly PlannedFile[] }): JSX.Element {
  const t = useTranslations('files')
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {files.slice(0, 6).map((file, index) => (
        <li key={`${index}:${file.originPath}`} className="truncate opacity-90">
          <span className="font-mono">{file.originPath}</span>
          {file.existingName && (
            <span className="opacity-80"> — {t('folderUpload.alreadyHereAs', { name: file.existingName })}</span>
          )}
          {file.existingArchived && <span className="opacity-80"> ({t('folderUpload.archivedMatch')})</span>}
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
          {rows.map((file, index) => (
            <li key={`${index}:${file.originPath}`} className="flex items-center gap-2 text-xs">
              <ActionTag action={file.action} includeUpdates={includeUpdates} />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {file.originPath}
              </span>
              {/* The document this row is about to touch, when the project
                  calls it something else — a rename here is invisible to the
                  drop, and approving a replacement you cannot locate is not
                  approval. */}
              {file.existingName && (
                <span className="max-w-[45%] shrink-0 truncate text-muted-foreground/80">
                  {t('folderUpload.alreadyHereAs', { name: file.existingName })}
                </span>
              )}
              {file.existingArchived && (
                <span className="shrink-0 text-muted-foreground/80">{t('folderUpload.archivedMatch')}</span>
              )}
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
    <CountPill tone={effective === 'new' || effective === 'update' ? 'attention' : 'muted'} data-testid={`folder-upload-action-${effective}`}>
      {label}
    </CountPill>
  )
}
