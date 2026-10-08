'use client'

import { isSystemFile } from '../lib/system-files'
import { useCallback, useRef, useState } from 'react'
import { loadUploadScreeningPolicy } from '@/adapters/api/upload-screening-policy'
import { digestFiles } from '../lib/content-digest'
import {
  buildFolderUploadPlan,
  isFolderUpload,
  needsUploadDecision,
  type FolderUploadPlan,
  type FolderUploadPlanInput,
  type PlanDocument,
} from '../lib/folder-upload-plan'

/**
 * Where the plan's documents come from: a list the caller already has, or —
 * what both shelves use — a probe asked with the dropped names
 * (`name-probe-client.ts`), which answers from the database what the upload
 * will match, whatever the browser happens to have loaded.
 */
export type PlanDocumentSource =
  | readonly PlanDocument[]
  | ((names: readonly string[]) => Promise<readonly PlanDocument[]>)

/** What the dialog is about: a directory tree, or files picked or dropped loose. */
export type UploadDecisionKind = 'folder' | 'files'

export interface UploadDecision {
  /**
   * Plan an upload against the shelf and either send it straight away
   * (`sendDirect`) or open the dialog. A function source is called with the
   * dropped names, so the comparison is against every document the upload
   * could touch rather than against the page of the listing on screen.
   */
  propose: (
    input: Omit<FolderUploadPlanInput, 'documents' | 'digests' | 'screening'> & {
      documents: PlanDocumentSource
      /**
       * The path of the folder the reader stands in, from the shelf root, or
       * null at the root: files are screened against where they land too.
       */
      screeningBasePath?: string | null
    },
    sendDirect: (files: File[]) => void
  ) => Promise<void>
  /**
   * The reader's answer for one file the upload screening excluded (ADR-0085):
   * upload it anyway, or not. Re-plans, because a released file can create a
   * folder and claim a name the excluded one did not.
   */
  setReleased: (file: File, released: boolean) => void
  plan: FolderUploadPlan | null
  kind: UploadDecisionKind
  open: boolean
  setOpen: (open: boolean) => void
  pending: boolean
  setPending: (pending: boolean) => void
}

/**
 * One answer to "a document of this name is already here", for every durable
 * shelf.
 *
 * A same-name upload replaces the live document with a new version (ADR-0054),
 * and whether it asked first used to depend on what THIS browser remembered:
 * a tab that had uploaded to the project before refused the file as „bereits
 * hinzugefügt", a fresh one replaced the document without a word. The shelf
 * itself is the one fact both browsers share, so the decision is made from it
 * — asked of the server by name (`name-probe-client.ts`), because the listing
 * on screen is paged, filtered and leaves archived documents out, and a match
 * it did not carry used to be versioned without a word.
 *
 * Files that match nothing go out at once; anything that would touch an
 * existing document opens the plan dialog first. A folder always opens it.
 */
export function useUploadDecision(): UploadDecision {
  const [plan, setPlan] = useState<FolderUploadPlan | null>(null)
  const [kind, setKind] = useState<UploadDecisionKind>('files')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  /**
   * The plan's own generation, so a second drop while the first is still being
   * hashed cannot land on top of it. Hashing a folder of models is seconds
   * long, which is ample time to drop another.
   */
  const generation = useRef(0)
  /** The last plan's input, digests included, so a release re-plans without re-reading anything. */
  const lastInput = useRef<FolderUploadPlanInput | null>(null)

  const propose = useCallback<UploadDecision['propose']>(async (dropped, sendDirect) => {
    // What the operating system left in the folder is not part of the upload.
    const input = { ...dropped, files: dropped.files.filter((file) => !isSystemFile(file.name)) }
    if (input.files.length === 0) return
    const current = ++generation.current
    const isFolder = isFolderUpload(input.files)
    const { screeningBasePath, ...planInput } = input
    const [documents, policy] = await Promise.all([
      typeof input.documents === 'function'
        ? input.documents([...new Set(input.files.map((file) => file.name))])
        : Promise.resolve(input.documents),
      loadUploadScreeningPolicy(),
    ])
    if (current !== generation.current) return
    const base: FolderUploadPlanInput = {
      ...planInput,
      documents,
      screening: { policy, basePath: screeningBasePath ?? null, released: new Set<File>() },
    }
    // First pass names the plausible duplicates; only those are read into
    // memory. Everything else is an upload either way. An excluded file is not
    // `new`, so the reader is always shown what the screening held back.
    const first = buildFolderUploadPlan(base)
    if (!isFolder && !needsUploadDecision(first)) {
      lastInput.current = null
      sendDirect([...input.files])
      return
    }
    setKind(isFolder ? 'folder' : 'files')
    setPlan(null)
    setPending(false)
    setOpen(true)
    const digests = await digestFiles(first.hashCandidates)
    if (current !== generation.current) return
    lastInput.current = { ...base, digests }
    setPlan(buildFolderUploadPlan(lastInput.current))
  }, [])

  const setReleased = useCallback<UploadDecision['setReleased']>((file, released) => {
    const input = lastInput.current
    if (!input?.screening) return
    const next = new Set(input.screening.released)
    if (released) next.add(file)
    else next.delete(file)
    lastInput.current = { ...input, screening: { ...input.screening, released: next } }
    setPlan(buildFolderUploadPlan(lastInput.current))
  }, [])

  return { propose, setReleased, plan, kind, open, setOpen, pending, setPending }
}
