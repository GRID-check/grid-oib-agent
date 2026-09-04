'use client'

/**
 * Dev preview for the folder-upload plan — the dialog a dropped directory tree
 * opens before anything moves. 404s outside development.
 *
 * The default fixture is the case the feature exists for: a büro re-syncing an
 * Einreichung a fortnight later. Most of it is unchanged and is skipped, a
 * handful of drawings have been corrected and are offered as an update, two
 * files are new, and the folders it needs were all matched to folders that
 * already exist rather than created beside them. What the shot has to prove is
 * that the four counts read as one sentence, and that the checkbox is visibly
 * the only decision on the surface.
 *
 * `?variant=first` is the OTHER half of the story: the first time this project
 * sees the folder. Nothing matches, every folder is created, and there is no
 * update question to ask — so the checkbox is absent rather than present and
 * unticked, which is the difference between "nothing to decide" and "decided
 * for you".
 *
 * `?variant=collisions` is the state that used to lose work silently. Two files
 * in one drop share a filename; a project holds one document per name
 * (migration 0074), so before the plan existed both uploaded and one overwrote
 * the other with nothing said. Neither is sent now, the pair is named, and the
 * upload button is disabled because the reader has something to fix first.
 *
 * `?variant=planning` is the seconds a large folder spends being read and
 * hashed before any of the above can be shown. It is a real state on a
 * 500-file drop and it says what it is doing, rather than leaving a bare
 * spinner over an empty dialog.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { FolderUploadDialog } from '@/features/documents/components/folder-upload-dialog'
import {
  buildFolderUploadPlan,
  type FolderUploadPlan,
} from '@/features/documents/lib/folder-upload-plan'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

/** A `File` carrying the path a folder input would report. */
function pathed(relativePath: string, size: number): File {
  const name = relativePath.split('/').pop()!
  const file = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function doc(filename: string, extra: Partial<FileItem> = {}): FileItem {
  return {
    id: `doc-${filename}`,
    filename,
    displayName: null,
    fileSize: 1_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: '2026-08-20T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees: [],
    authoredBy: 'user',
    ...extra,
  }
}

const IDENTICAL = `sha256:${'a'.repeat(64)}`

const FOLDERS: FolderItem[] = [
  { id: 'f-root', parentId: null, name: 'Wohnbau Nord', path: 'Wohnbau Nord' },
  { id: 'f-plaene', parentId: 'f-root', name: 'Pläne', path: 'Wohnbau Nord/Pläne' },
  { id: 'f-statik', parentId: 'f-root', name: 'Statik', path: 'Wohnbau Nord/Statik' },
]

/** The re-sync: mostly unchanged, a few corrections, two genuinely new files. */
function resyncPlan(): FolderUploadPlan {
  const unchanged = [
    pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
    pathed('Wohnbau Nord/Pläne/OG.pdf', 1_000),
    pathed('Wohnbau Nord/Statik/Bewehrung.pdf', 1_000),
  ]
  const corrected = [
    pathed('Wohnbau Nord/Pläne/Schnitt_A.pdf', 2_400),
    pathed('Wohnbau Nord/Statik/Nachweis.pdf', 2_400),
  ]
  const fresh = [
    pathed('Wohnbau Nord/Pläne/Detail_Attika.pdf', 900),
    pathed('Wohnbau Nord/Brandschutz/Konzept.pdf', 900),
  ]

  return buildFolderUploadPlan({
    files: [...unchanged, ...corrected, ...fresh],
    folders: FOLDERS,
    currentFolderId: null,
    documents: [
      // Filed where the first sync put them, which is where this one puts them
      // too — a re-sync does not move anything it does not have to.
      doc('EG.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      doc('OG.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      doc('Bewehrung.pdf', { fileSize: 1_000, contentHash: IDENTICAL, folderId: 'f-statik' }),
      // Same name, same size, different bytes — the case only a digest can tell
      // apart, and the reason the column exists.
      doc('Schnitt_A.pdf', { fileSize: 2_400, contentHash: IDENTICAL, folderId: 'f-plaene' }),
      // Somebody re-filed this one in Piloti after the first sync. The tree
      // puts it back, and the dialog says so before it moves.
      doc('Nachweis.pdf', { fileSize: 2_400, contentHash: IDENTICAL, folderId: null }),
    ],
    digests: new Map([
      ...unchanged.map((file) => [file, IDENTICAL] as const),
      ...corrected.map((file) => [file, `sha256:${'b'.repeat(64)}`] as const),
    ]),
  })
}

/** The first sync: nothing here yet, so every folder is a creation. */
function firstPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [
      pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
      pathed('Wohnbau Nord/Pläne/OG.pdf', 1_000),
      pathed('Wohnbau Nord/Statik/Nachweis.pdf', 1_000),
    ],
    documents: [],
    folders: [],
    currentFolderId: null,
  })
}

/** Two files, one name — the loss the plan reports instead of committing. */
function collisionPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [
      pathed('Wohnbau Nord/Pläne/Deckblatt.pdf', 1_000),
      pathed('Wohnbau Nord/Statik/Deckblatt.pdf', 1_200),
      pathed('Wohnbau Nord/Pläne/EG.pdf', 1_000),
    ],
    documents: [],
    folders: FOLDERS,
    currentFolderId: null,
  })
}

export default function FolderUploadPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const variant = useSearchParams()?.get('variant') ?? 'resync'
  const plan =
    variant === 'planning'
      ? null
      : variant === 'first'
        ? firstPlan()
        : variant === 'collisions'
          ? collisionPlan()
          : resyncPlan()

  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="folder-upload-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">
        /dev/folder-upload — {variant}
      </h1>
      <FolderUploadDialog
        open
        onOpenChange={() => {}}
        plan={plan}
        currentFolderName={null}
        onConfirm={() => {}}
      />
    </main>
  )
}
