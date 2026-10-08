/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/folder-path', () => ({ resolveShelfFolderPath: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findLiveDocumentByFilename: vi.fn(async () => null) }))
vi.mock('@/lib/documents/shelf-collection', () => ({ shelfCollectionName: vi.fn(async () => 'collection_p1') }))
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

import { BadRequestError, InsufficientStorageError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { findLiveDocumentByFilename } from '@/lib/documents/repository'
import { assertUploadTypeAllowed, uploadDocument } from '@/lib/documents/service'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { createProjectFolder, ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { readArchiveAttachment, type ArchiveMail } from './archive-client'
import { fileMail, filingContext, MailImportQuotaError, type FilingContext } from './filing'
import { markInflight } from './repository'

const session = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession
const mailImport = { id: 'imp_1', projectId: 'p1', inflightPosition: null, inflightFolderId: null } as unknown as MailImport

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

async function context(overrides: Partial<MailImport> = {}): Promise<FilingContext> {
  return filingContext({
    session,
    mailImport: { ...mailImport, ...overrides },
    archive: { key: 'k', url: 'u', size: 10 },
    archiveFolderId: 'folder_archive',
    request: new Request('http://bff-jobs.internal'),
  })
}

function uploadedNames(): string[] {
  return vi.mocked(uploadDocument).mock.calls.map(([, input]) => input.file.name)
}

beforeEach(() => {
  vi.clearAllMocks()
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
    vi.mocked(findLiveDocumentByFilename).mockImplementation(async (_org, _collection, name) =>
      name === `${LEAF} – Plan.pdf` ? ({ folderId: 'folder_somewhere_else' } as never) : name === `${LEAF}.md` ? ({ folderId: 'folder_mail' } as never) : null,
    )

    await fileMail(await context(), mail)
    expect(uploadedNames()).toEqual([`${LEAF} – Plan (2).pdf`, `${LEAF}.md`])
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

  it('turns a full quota into the error that ends the import', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new InsufficientStorageError())
    await expect(fileMail(await context(), mail)).rejects.toBeInstanceOf(MailImportQuotaError)
  })
})
