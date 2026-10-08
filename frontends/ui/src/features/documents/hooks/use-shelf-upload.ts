'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import type { FolderItem } from '../file-types'
import { takeDroppedFiles } from '../lib/dropped-file-handover'
import { filesToUpload, samePlanOutcome, type FolderUploadPlan, type PlannedMove } from '../lib/folder-upload-plan'
import { isZipArchive } from '../lib/zip-types'
import type { FileShelf, ShelfEndpoints, ShelfUploadApi } from '../lib/file-shelf'
import { useUploadDecision, type SettledPlan } from './use-upload-decision'
import { UploadScreeningPolicyUnavailableError } from '@/adapters/api/upload-screening-policy'

export interface ShelfUploadOptions {
  shelf: Pick<FileShelf, 'probeNames' | 'handoverKey'> & { endpoints: Pick<ShelfEndpoints, 'folders'> }
  upload: Pick<ShelfUploadApi, 'uploadFiles'>
  folders: readonly FolderItem[]
  foldersReady: boolean
  selectedFolderId: string | null
  loadFolders: () => Promise<unknown>
  loadFiles: (quiet?: boolean) => Promise<unknown>
}

/*
 * A FOLDER IS NOT A LONGER LIST OF FILES.
 *
 * Every upload on a shelf — the button, the folder item in its menu, the dashed
 * tile, a drop onto the workspace — comes through `handleUpload`, and this is
 * where the two gestures part company. A handful of picked files goes straight
 * to `uploadFiles`. A directory tree does not: it carries a structure, it
 * usually overlaps what is already on the shelf, and applying it silently was
 * costing work: the tree collapsed into whichever folder the reader stood in,
 * same-name files replaced live documents without saying so, and two files of
 * one name inside one drop both uploaded, one overwriting the other.
 *
 * Loose files take the same plan. A file whose name the shelf already holds
 * becomes a new version of that document (ADR-0054), so it asks „Neue Fassung
 * von „X“ hochladen?" — decided by asking the server by name (`probeNames`),
 * never from what this browser happens to have loaded.
 *
 * Every path is screened against the office's sensitive-data list (ADR-0085),
 * on both shelves: the plan shows what the screening holds back and takes the
 * reader's releases, and each upload names the folder it lands in so the
 * browser and the server screen the same path.
 */
export function useShelfUpload({
  shelf,
  upload,
  folders,
  foldersReady,
  selectedFolderId,
  loadFolders,
  loadFiles,
}: ShelfUploadOptions) {
  const t = useTranslations('files')
  const decision = useUploadDecision()
  const { propose, setReleased, settle, plan, setOpen, setPending } = decision
  const { uploadFiles } = upload
  const { probeNames, handoverKey } = shelf
  const ensureUrl = `${shelf.endpoints.folders}/ensure`

  /**
   * The path of the folder the reader stands in, from the shelf root, or null
   * at the root. The upload screening reads it (ADR-0085): a scan dropped into
   * „Honorare" is screened as a fee document whatever its own name.
   */
  const currentFolderPath = useMemo(
    () => (selectedFolderId ? (folders.find((folder) => folder.id === selectedFolderId)?.path ?? null) : null),
    [folders, selectedFolderId]
  )

  /**
   * A ZIP is unpacked first and then goes through exactly what a dropped folder
   * does. The unzip library is loaded only when there is one to unpack: most
   * uploads are PDFs, and the chat's bundle never needed it.
   */
  const unpackArchives = useCallback(
    async (incoming: File[]): Promise<File[]> => {
      if (!incoming.some(isZipArchive)) return incoming
      const reading = toast.loading(t('zip.reading'))
      try {
        const { expandZips } = await import('../lib/expand-zip')
        const { files, notes } = await expandZips(incoming)
        for (const note of notes) toast.error(t(`zip.${note.reason}`, { name: note.zip, limit: note.limit }))
        return files
      } finally {
        toast.dismiss(reading)
      }
    },
    [t]
  )

  const handleUpload = useCallback(
    (incoming: File[]) => {
      unpackArchives(incoming)
        .then((files) => {
          if (files.length === 0) return undefined
          return propose(
            {
              files,
              documents: probeNames,
              folders,
              currentFolderId: selectedFolderId,
              screeningBasePath: currentFolderPath,
            },
            (direct) => void uploadFiles(direct, { folderPathFor: () => currentFolderPath })
          )
        })
        .catch((error: unknown) =>
          toast.error(
            error instanceof UploadScreeningPolicyUnavailableError
              ? t('errors.screeningPolicyUnavailable')
              : t('folderUpload.compareError')
          )
        )
    },
    [unpackArchives, propose, probeNames, uploadFiles, folders, selectedFolderId, currentFolderPath, t]
  )

  /** A release asks the name probe about the file; when it cannot, the file stays held back and the reader is told. */
  const onReleaseChange = useCallback(
    (file: File, released: boolean) => {
      setReleased(file, released).catch(() => toast.error(t('folderUpload.compareError')))
    },
    [setReleased, t]
  )

  // A drop elsewhere in the app brought the reader here (`ProjectFileDrop`).
  // Taken once, and not before the folders are in: a dropped tree is planned
  // against them, and an empty list would rebuild folders the shelf already has.
  useEffect(() => {
    if (!handoverKey || !foldersReady) return
    const handedOver = takeDroppedFiles(handoverKey)
    if (handedOver.length > 0) handleUpload(handedOver)
  }, [handoverKey, handleUpload, foldersReady])

  /** The folders first and in ONE request: forty creates would be forty chances to end with half a tree. Nothing uploads if it fails. */
  const ensureFolders = useCallback(
    async (paths: string[]): Promise<Record<string, string> | null> => {
      if (paths.length === 0) return {}
      try {
        const res = await fetch(ensureUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId: selectedFolderId, paths }),
        })
        if (!res.ok) throw new Error(`Folders failed (${res.status})`)
        const data = (await res.json()) as { folderIdByPath?: Record<string, string> }
        return data.folderIdByPath ?? {}
      } catch {
        // The dialog STAYS OPEN: nothing was uploaded, the plan is still the
        // plan, and a toast alone would be the only account of a gesture the
        // reader is entitled to simply retry.
        setPending(false)
        toast.error(t('folderUpload.foldersError'))
        return null
      }
    },
    [ensureUrl, selectedFolderId, setPending, t]
  )

  /**
   * The documents already here, already correct, and filed somewhere the tree
   * does not put them: nothing is uploaded for them, so without this the dialog's
   * promise ("the folder structure is recreated") is false for exactly the files
   * a re-sync is mostly made of. `allSettled`: one refused move must not take
   * the upload down with it; the reload is what tells the truth.
   */
  const applyMoves = useCallback(
    (moves: readonly PlannedMove[], byPath: Record<string, string>) =>
      Promise.allSettled(
        moves.map((move) =>
          fetch(`/api/documents/${move.documentId}/folder`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // Through the SAME map the uploads resolve through, and only now:
            // the folder may have been created a moment ago.
            body: JSON.stringify({
              folderId: move.targetPath ? (byPath[move.targetPath] ?? selectedFolderId) : selectedFolderId,
            }),
          })
        )
      ),
    [selectedFolderId]
  )

  /**
   * The plan the reader confirmed, as it may be applied now (`settle`): a
   * release still being asked about answered, and the office's policy read
   * afresh, BEFORE the folders are made, because a folder's name is sent with
   * them. When settling changed what would happen, nothing is sent: the dialog
   * shows the new plan and the reader confirms that one. Null when nothing may
   * go, and the reader has been told why.
   */
  const settlePlan = useCallback(
    async (shown: FolderUploadPlan): Promise<SettledPlan | null> => {
      try {
        const settled = await settle()
        if (!settled) return null
        if (samePlanOutcome(shown, settled.plan)) return settled
        toast.error(t('folderUpload.planChanged'))
      } catch (error) {
        toast.error(
          error instanceof UploadScreeningPolicyUnavailableError
            ? t('errors.screeningPolicyUnavailable')
            : t('folderUpload.compareError')
        )
      }
      return null
    },
    [settle, t]
  )

  const applyFolderPlan = useCallback(
    async (includeUpdates: boolean) => {
      if (!plan) return
      if (filesToUpload(plan, includeUpdates).length === 0 && plan.moves.length === 0) return
      setPending(true)

      const settled = await settlePlan(plan)
      if (!settled) {
        setPending(false)
        return
      }
      const { policy } = settled
      const selected = filesToUpload(settled.plan, includeUpdates)
      const moves = settled.plan.moves

      const byPath = await ensureFolders(settled.plan.folders.map((folder) => folder.path))
      if (byPath === null) return

      try {
        // Per file rather than per batch — that is the point of reproducing the
        // tree. A file at the top of the drop belongs where the reader stands.
        const folderIdByFile = new Map<File, string | null>()
        for (const planned of selected) {
          folderIdByFile.set(
            planned.file,
            planned.targetPath ? (byPath[planned.targetPath] ?? selectedFolderId) : selectedFolderId
          )
        }
        // What the server screens each file against: the folder it lands in
        // (ADR-0085), and whether the reader released it in the dialog.
        const plannedByFile = new Map(selected.map((planned) => [planned.file, planned]))
        setOpen(false)
        if (moves.length > 0) await applyMoves(moves, byPath)
        if (selected.length > 0) {
          await uploadFiles(
            selected.map((planned) => planned.file),
            {
              folderIdFor: (file) => folderIdByFile.get(file) ?? null,
              folderPathFor: (file) => {
                const target = plannedByFile.get(file)?.targetPath ?? ''
                return [currentFolderPath, target].filter(Boolean).join('/') || null
              },
              screeningReleased: (file) => plannedByFile.get(file)?.screeningReleased === true,
              // The policy this plan was just settled against: read once, so
              // what the dialog applies and what the upload screens agree.
              screeningPolicy: policy,
              excludedByScreening: settled.plan.files
                .filter((planned) => planned.action === 'excluded')
                .map((planned) => planned.screening ?? []),
            }
          )
        }
        // The tree grew and a move wrote rows this page shows; `uploadFiles`
        // only refreshes the listing when it actually uploaded something.
        await loadFolders()
        await loadFiles(true)
        const counts = { uploaded: String(selected.length), skipped: String(settled.plan.counts.unchanged) }
        // A move-only apply uploads nothing, and „0 Dateien hochgeladen" alone
        // would read as a failed gesture over work that was actually done.
        toast.success(
          moves.length > 0
            ? t('folderUpload.doneMoved', { ...counts, moved: String(moves.length) })
            : t('folderUpload.done', counts)
        )
      } catch {
        toast.error(t('folderUpload.applyError'))
      } finally {
        setPending(false)
      }
    },
    [
      plan,
      selectedFolderId,
      currentFolderPath,
      uploadFiles,
      loadFolders,
      loadFiles,
      ensureFolders,
      applyMoves,
      settlePlan,
      t,
      setOpen,
      setPending,
    ]
  )

  return { handleUpload, applyFolderPlan, onReleaseChange, decision }
}
