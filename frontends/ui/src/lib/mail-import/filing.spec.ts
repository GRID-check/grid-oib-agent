/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/folder-path', () => ({ resolveShelfFolderPath: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({
  findLiveDocumentByFilename: vi.fn(async () => null),
  findProjectCollectionsHoldingFilename: vi.fn(async () => []),
}))
vi.mock('@/lib/documents/service', () => ({
  assertUploadTypeAllowed: vi.fn(),
  assertFileSizeAllowed: vi.fn(),
  uploadDocument: vi.fn(async () => ({ documentId: 'd', jobId: null, status: 'uploaded', filename: 'x' })),
}))
vi.mock('@/lib/projects/folder-service', () => ({
  createProjectFolder: vi.fn(),
  ensureProjectFolderPaths: vi.fn(async (input: { paths: string[] }) => ({
    ok: true,
    folders: [],
    folderIdByPath: Object.fromEntries(input.paths.map((path) => [path, `folder:${path}`])),
  })),
}))
vi.mock('./archive-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./archive-client')>()
  return { ...actual, readArchiveAttachment: vi.fn(async () => new Uint8Array([1, 2, 3])) }
})
vi.mock('./repository', () => ({ markInflight: vi.fn(async () => true) }))
const batchStore = vi.hoisted(() => new Map<string, { sealed: boolean; documents: number }>())
vi.mock('@/lib/upload-batches/service', () => ({
  UPLOAD_BATCH_MAX_FILES: 2,
  findJobUploadBatch: vi.fn(async (_org: string, id: string) => {
    const batch = batchStore.get(id)
    if (!batch) return { status: 'missing' }
    return batch.sealed ? { status: 'sealed' } : { status: 'open', documents: batch.documents }
  }),
  openUploadBatch: vi.fn(async (_session: unknown, input: { id: string }) => {
    batchStore.set(input.id, { sealed: false, documents: 0 })
  }),
  sealJobUploadBatch: vi.fn(async (_org: string, id: string) => {
    const batch = batchStore.get(id)
    if (batch) batch.sealed = true
  }),
}))

import { BadRequestError, ConflictError, FileTooLargeError, ForbiddenError, InsufficientStorageError } from '@/lib/api/errors'
import { folderReadOnlyError } from '@/lib/authz/folder-access-rule'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { findLiveDocumentByFilename, findProjectCollectionsHoldingFilename } from '@/lib/documents/repository'
import { assertFileSizeAllowed, assertUploadTypeAllowed, uploadDocument } from '@/lib/documents/service'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { createProjectFolder, ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { ScreenedUploadError } from '@/lib/upload-screening/service'
import { AttachmentUnreadableError, readArchiveAttachment, type ArchiveMail } from './archive-client'
import {
  fileMail,
  filingContext,
  ImportMovedOnError,
  MailImportQuotaError,
  SliceBudgetSpentError,
  type FilingContext,
} from './filing'
import { markInflight } from './repository'
import { openUploadBatch, sealJobUploadBatch } from '@/lib/upload-batches/service'
import { importBatchId, type ImportBatch } from './upload-batch'

const session = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession
const mailImport = { id: 'imp_1', organizationId: 'org_1', userId: 'user_anna', projectId: 'p1', inflightPosition: null, inflightFolderId: null } as unknown as MailImport

const mail: ArchiveMail = {
  kind: 'mail',
  position: 7,
  message_class: 'IPM.Note',
  folder_path: ['Posteingang', 'Behörde'],
  subject: 'Plan',
  sender: { name: 'Anna Berger', address: 'anna@buero.at' },
  to: [],
  cc: [],
  sent_at: '2026-09-30T08:15:00Z',
  received_at: null,
  message_id: null,
  body: { text: 'Hallo', source: 'plain', truncated: false },
  attachments: [
    { index: 0, filename: 'Plan.pdf', content_type: 'application/pdf', size: 3, inline: false, embedded_message: false },
    { index: 1, filename: 'logo.png', content_type: 'image/png', size: 3, inline: true, embedded_message: false },
    { index: 2, filename: 'Fwd', content_type: null, size: 0, inline: false, embedded_message: true },
  ],
}

const LEAF = '2026-09-30 10.15 – Anna Berger'

const BATCH_0 = importBatchId('imp_1', 0)

async function context(
  overrides: Partial<MailImport> = {},
  deadline?: number,
  uploadBatch: ImportBatch = { id: BATCH_0, generation: 0, documents: 0 },
): Promise<FilingContext> {
  return filingContext({
    session,
    mailImport: { ...mailImport, ...overrides },
    archive: { key: 'k', url: 'u', size: 10 },
    archiveFolderId: 'folder_archive',
    request: new Request('http://bff-jobs.internal'),
    deadline,
    uploadBatch,
  })
}

function uploadedNames(): string[] {
  return vi.mocked(uploadDocument).mock.calls.map(([, input]) => input.file.name)
}

/** Documents of the project by name: the collection that holds each, and the folder it is filed in. */
function projectHolds(byName: Record<string, { collection: string; folderId: string }[]>): void {
  vi.mocked(findProjectCollectionsHoldingFilename).mockImplementation(async (_org, _project, name) =>
    (byName[name] ?? []).map((held) => held.collection),
  )
  vi.mocked(findLiveDocumentByFilename).mockImplementation(async (_org, collection, name) => {
    const held = (byName[name] ?? []).find((entry) => entry.collection === collection)
    return held ? ({ folderId: held.folderId } as never) : null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  batchStore.clear()
  batchStore.set(BATCH_0, { sealed: false, documents: 0 })
  // Back to the factory's upload, so a queued refusal a failed test left unread cannot leak into the next.
  vi.mocked(uploadDocument).mockReset()
  projectHolds({})
  vi.mocked(createProjectFolder).mockResolvedValue({ ok: true, folder: { id: 'folder_mail', name: LEAF } } as never)
})

describe('fileMail', () => {
  it('files the attachment and the note into a new mail folder under the Outlook path, skipping inline and embedded', async () => {
    const result = await fileMail(await context(), mail)

    expect(ensureProjectFolderPaths).toHaveBeenCalledWith(
      { projectId: 'p1', parentId: 'folder_archive', paths: ['Posteingang/Behörde'] },
      session,
    )
    expect(createProjectFolder).toHaveBeenCalledWith({ projectId: 'p1', parentId: 'folder:Posteingang/Behörde', name: LEAF }, session)
    expect(markInflight).toHaveBeenCalledWith('org_1', 'imp_1', 7, 'folder_mail')
    expect(uploadedNames()).toEqual([`${LEAF} – Plan.pdf`, `${LEAF}.md`])
    expect(vi.mocked(uploadDocument).mock.calls[0][1]).toMatchObject({ folderId: 'folder_mail', priority: 'bulk' })
    expect(readArchiveAttachment).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ filesFiled: 1, filesSkipped: 1, skipped: [{ file: 'Fwd', reason: 'embedded_message' }] })
  })

  it('numbers the mail folder when a sibling already has its name', async () => {
    vi.mocked(createProjectFolder)
      .mockResolvedValueOnce({ ok: false, error: FOLDER_NAME_TAKEN })
      .mockResolvedValueOnce({ ok: true, folder: { id: 'folder_mail_2', name: `${LEAF} (2)` } } as never)

    await fileMail(await context(), mail)
    expect(vi.mocked(createProjectFolder).mock.calls[1][0].name).toBe(`${LEAF} (2)`)
    expect(uploadedNames()).toContain(`${LEAF} (2).md`)
  })

  it('resumes into the folder a died slice recorded instead of making a second one', async () => {
    vi.mocked(resolveShelfFolderPath).mockResolvedValueOnce(`E-Mail-Import/Büro/Posteingang/${LEAF}`)

    await fileMail(await context({ inflightPosition: 7, inflightFolderId: 'folder_earlier' }), mail)
    expect(createProjectFolder).not.toHaveBeenCalled()
    expect(vi.mocked(uploadDocument).mock.calls[0][1].folderId).toBe('folder_earlier')
  })

  it('numbers a file whose name another folder of the project already has, and reuses it in its own folder', async () => {
    projectHolds({
      [`${LEAF} – Plan.pdf`]: [{ collection: 'collection_p1', folderId: 'folder_somewhere_else' }],
      [`${LEAF}.md`]: [{ collection: 'collection_p1', folderId: 'folder_mail' }],
    })

    await fileMail(await context(), mail)
    expect(uploadedNames()).toEqual([`${LEAF} – Plan (2).pdf`, `${LEAF}.md`])
  })

  it('probes a name across every collection of the project, so a restricted folder’s document is numbered past, not superseded', async () => {
    projectHolds({
      // Filed in a folder with its own access list, which keeps its own collection (ADR-0087).
      [`${LEAF} – Plan.pdf`]: [{ collection: 'collection_p1_restricted', folderId: 'folder_vertraulich' }],
      // The same name in two collections: no folder of this mail holds it alone.
      [`${LEAF}.md`]: [
        { collection: 'collection_p1', folderId: 'folder_other' },
        { collection: 'collection_p1_restricted', folderId: 'folder_mail' },
      ],
    })

    await fileMail(await context(), mail)
    expect(uploadedNames()).toEqual([`${LEAF} – Plan (2).pdf`, `${LEAF} (2).md`])
    expect(findProjectCollectionsHoldingFilename).toHaveBeenCalledWith('org_1', 'p1', `${LEAF} – Plan.pdf`)
  })

  it('files a retry into a restricted mail folder under the same name, its own collection holding it', async () => {
    projectHolds({ [`${LEAF}.md`]: [{ collection: 'collection_p1_restricted', folderId: 'folder_mail' }] })

    await fileMail(await context(), mail)
    expect(uploadedNames()).toContain(`${LEAF}.md`)
  })

  it('skips a file whose name the project claimed elsewhere between the probe and the upload, and files the rest', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new ConflictError('A document named "x" already exists elsewhere in this project.'))

    const result = await fileMail(await context(), mail)
    expect(result.skipped).toContainEqual({ mail: LEAF, file: 'Plan.pdf', reason: 'name_taken' })
    expect(result).toMatchObject({ filesFiled: 0 })
    expect(uploadedNames().at(-1)).toBe(`${LEAF}.md`)
  })

  it('skips a file into a folder that turned read-only under the import, without failing the mail', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(folderReadOnlyError()).mockRejectedValueOnce(folderReadOnlyError())

    const result = await fileMail(await context(), mail)
    expect(result.skipped).toEqual([
      { mail: LEAF, file: 'Plan.pdf', reason: 'access' },
      { mail: LEAF, file: 'Fwd', reason: 'embedded_message' },
      { mail: LEAF, file: `${LEAF}.md`, reason: 'access' },
    ])
  })

  it('lets any other refusal of the upload fail the mail', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new ForbiddenError())
    await expect(fileMail(await context(), mail)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('skips an attachment the upload gate refuses, without reading its bytes', async () => {
    vi.mocked(assertUploadTypeAllowed).mockImplementation(async (_session, name) => {
      if (name.endsWith('.pdf')) throw new BadRequestError('not permitted')
    })

    const result = await fileMail(await context(), mail)
    expect(readArchiveAttachment).not.toHaveBeenCalled()
    expect(result.skipped).toContainEqual({ mail: LEAF, file: 'Plan.pdf', reason: 'type' })
    vi.mocked(assertUploadTypeAllowed).mockReset()
  })

  it('skips an attachment over the organization’s file limit, before or during the upload, without failing the mail', async () => {
    vi.mocked(assertFileSizeAllowed).mockRejectedValueOnce(new FileTooLargeError({ fileSize: 3, maxSizeBytes: 1 }))
    const before = await fileMail(await context(), mail)
    expect(readArchiveAttachment).not.toHaveBeenCalled()
    expect(before.skipped).toContainEqual({ mail: LEAF, file: 'Plan.pdf', reason: 'size' })

    vi.mocked(uploadDocument).mockRejectedValueOnce(new FileTooLargeError({ fileSize: 3, maxSizeBytes: 1 }))
    const during = await fileMail(await context(), mail)
    expect(during.skipped).toContainEqual({ mail: LEAF, file: 'Plan.pdf', reason: 'size' })
    expect(uploadedNames().at(-1)).toBe(`${LEAF}.md`)
  })

  it('numbers the second of two same-named attachments of one mail instead of overwriting the first', async () => {
    const twins: ArchiveMail = {
      ...mail,
      attachments: [
        { index: 0, filename: 'scan.pdf', content_type: 'application/pdf', size: 3, inline: false, embedded_message: false },
        { index: 1, filename: 'scan.pdf', content_type: 'application/pdf', size: 3, inline: false, embedded_message: false },
      ],
    }
    await fileMail(await context(), twins)
    expect(uploadedNames()).toEqual([`${LEAF} – scan.pdf`, `${LEAF} – scan (2).pdf`, `${LEAF}.md`])

    // A retry of the mail, both already in its folder, arrives at the same two names.
    vi.mocked(uploadDocument).mockClear()
    const inEarlier = [{ collection: 'collection_p1', folderId: 'folder_earlier' }]
    projectHolds({ [`${LEAF} – scan.pdf`]: inEarlier, [`${LEAF} – scan (2).pdf`]: inEarlier, [`${LEAF}.md`]: inEarlier })
    vi.mocked(resolveShelfFolderPath).mockResolvedValueOnce(`E-Mail-Import/Büro/${LEAF}`)
    await fileMail(await context({ inflightPosition: 7, inflightFolderId: 'folder_earlier' }), twins)
    expect(uploadedNames()).toEqual([`${LEAF} – scan.pdf`, `${LEAF} – scan (2).pdf`, `${LEAF}.md`])
  })

  it('skips a file the office’s name screening holds back and carries on with the next one', async () => {
    const two: ArchiveMail = {
      ...mail,
      attachments: [
        { index: 0, filename: 'Vertrag.pdf', content_type: 'application/pdf', size: 3, inline: false, embedded_message: false },
        { index: 1, filename: 'Plan.pdf', content_type: 'application/pdf', size: 3, inline: false, embedded_message: false },
      ],
    }
    vi.mocked(uploadDocument).mockRejectedValueOnce(
      new ScreenedUploadError([{ term: 'Vertrag', segment: `${LEAF} – Vertrag.pdf`, kind: 'file' }]),
    )

    const result = await fileMail(await context(), two)
    expect(result).toMatchObject({
      filesFiled: 1,
      filesSkipped: 1,
      skipped: [{ mail: LEAF, file: 'Vertrag.pdf', reason: 'screened' }],
    })
    expect(uploadedNames()).toEqual([`${LEAF} – Vertrag.pdf`, `${LEAF} – Plan.pdf`, `${LEAF}.md`])
  })

  it('never releases a screened name on the person’s behalf', async () => {
    await fileMail(await context(), mail)
    expect(uploadDocument).toHaveBeenCalled()
    for (const [, input] of vi.mocked(uploadDocument).mock.calls) {
      expect(input).not.toHaveProperty('screeningRelease')
    }
  })

  it('skips a damaged attachment and files the rest', async () => {
    vi.mocked(readArchiveAttachment).mockRejectedValueOnce(new AttachmentUnreadableError())
    const result = await fileMail(await context(), mail)
    expect(result.skipped).toContainEqual({ mail: LEAF, file: 'Plan.pdf', reason: 'unreadable' })
    expect(uploadedNames()).toEqual([`${LEAF}.md`])
  })

  it('stops between two files when the slice is out of time, its folder recorded for the next one', async () => {
    await expect(fileMail(await context({}, Date.now() - 1), mail)).rejects.toBeInstanceOf(SliceBudgetSpentError)
    expect(markInflight).toHaveBeenCalledWith('org_1', 'imp_1', 7, 'folder_mail')
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('files nothing into a folder when the import moved on under the slice', async () => {
    vi.mocked(markInflight).mockResolvedValueOnce(false)
    await expect(fileMail(await context(), mail)).rejects.toBeInstanceOf(ImportMovedOnError)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('turns a full quota into the error that ends the import', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new InsufficientStorageError())
    await expect(fileMail(await context(), mail)).rejects.toBeInstanceOf(MailImportQuotaError)
  })
})

describe('fileMail, upload batch', () => {
  const batchIds = () => vi.mocked(uploadDocument).mock.calls.map(([, input]) => input.uploadBatchId)

  it("stamps every file of the mail with the import's upload batch", async () => {
    const filing = await context()
    await fileMail(filing, mail)

    expect(batchIds()).toEqual([BATCH_0, BATCH_0])
    expect(filing.uploadBatch).toMatchObject({ id: BATCH_0, documents: 2 })
  })

  it('seals a full batch and files the rest into the next one', async () => {
    batchStore.set(BATCH_0, { sealed: false, documents: 1 })
    const filing = await context({}, undefined, { id: BATCH_0, generation: 0, documents: 1 })
    await fileMail(filing, mail)

    const next = importBatchId('imp_1', 1)
    expect(batchIds()).toEqual([BATCH_0, next])
    expect(sealJobUploadBatch).toHaveBeenCalledWith('org_1', BATCH_0, 'user_anna')
    expect(openUploadBatch).toHaveBeenCalledWith(session, expect.objectContaining({ id: next, scope: 'project', projectId: 'p1' }))
    expect(filing.uploadBatch).toMatchObject({ id: next, generation: 1, documents: 1 })
  })

  it('does not count a file whose bytes were already there', async () => {
    vi.mocked(uploadDocument).mockResolvedValueOnce({ documentId: 'd', jobId: null, status: 'uploaded', filename: 'x', unchanged: true })
    const filing = await context()
    await fileMail(filing, mail)

    expect(filing.uploadBatch.documents).toBe(1)
  })
})
