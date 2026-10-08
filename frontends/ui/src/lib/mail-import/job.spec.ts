/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/documents/shelf-authz', () => ({ requireShelfWrite: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({
  getOrCreateProjectFolderByName: vi.fn(async () => ({ id: 'folder_root', name: 'E-Mail-Import' })),
}))
vi.mock('./staging', () => ({ archiveUrlForBackend: vi.fn(async () => 'http://seaweedfs/presigned') }))
vi.mock('./service', () => ({ discardStaging: vi.fn() }))
vi.mock('./archive-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./archive-client')>()
  return { ...actual, readArchivePage: vi.fn() }
})
vi.mock('./filing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filing')>()
  return {
    ...actual,
    createFolderWithFreeName: vi.fn(async () => ({ id: 'folder_archive', name: 'Büro 2019' })),
    filingContext: vi.fn(async (input: object) => ({ ...input, collectionName: 'c', folders: new Map() })),
    fileMail: vi.fn(async () => ({ folderName: 'm', filesFiled: 2, filesSkipped: 1, skipped: [{ mail: 'm', file: 'x.exe', reason: 'type' }] })),
  }
})
vi.mock('./repository', () => ({
  findMailImport: vi.fn(),
  updateMailImport: vi.fn(),
  advanceMailImport: vi.fn(async () => true),
  listStaleOpenImports: vi.fn(async () => []),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { emitInboxItems } from '@/lib/inbox/service'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { readArchivePage, UnreadableArchiveError, type ArchivePage } from './archive-client'
import { fileMail, MailImportQuotaError } from './filing'
import { runMailImportSlice, sweepStaleMailImports } from './job'
import * as repository from './repository'
import { discardStaging } from './service'

const session = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession

function row(overrides: Partial<MailImport> = {}): MailImport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org_1',
    projectId: '22222222-2222-4222-8222-222222222222',
    userId: 'user_anna',
    userEmail: null,
    filename: 'Büro 2019.pst',
    sizeBytes: 1000,
    status: 'importing',
    stagingBucket: 'b',
    stagingKey: 'k',
    uploadId: null,
    stagingDeletedAt: null,
    rootFolderId: 'folder_archive',
    totalItems: 2,
    nextPosition: 0,
    inflightPosition: null,
    inflightFolderId: null,
    mailsFiled: 0,
    filesFiled: 0,
    itemsSkipped: 0,
    filesSkipped: 0,
    skippedSamples: [],
    errorCode: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  }
}

const payload = {
  importId: row().id,
  projectId: row().projectId,
  requester: { userId: 'user_anna', email: '', organizationMembershipId: 'om_1', role: 'member', permissions: [] },
}

const mail = {
  kind: 'mail' as const,
  position: 0,
  message_class: 'IPM.Note',
  folder_path: ['Posteingang'],
  subject: 'Plan',
  sender: null,
  to: [],
  cc: [],
  sent_at: null,
  received_at: null,
  message_id: null,
  body: { text: '', source: 'none', truncated: false },
  attachments: [],
}
const contact = { kind: 'other' as const, position: 1, message_class: 'IPM.Contact', folder_path: ['Kontakte'] }

function page(messages: ArchivePage['messages'], next: number | null, total = 2): ArchivePage {
  return { total, next_position: next, messages }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(repository.updateMailImport).mockImplementation(async (_org, _id, _from, patch) => ({ ...row(), ...patch }))
})

describe('runMailImportSlice', () => {
  it('files mails, counts other items as skipped, moves the cursor past each, and completes', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, contact], null))

    const result = await runMailImportSlice(session, payload, { last: false }, 'org_1')

    expect(result.done).toBe(true)
    expect(fileMail).toHaveBeenCalledOnce()
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(1, 'org_1', payload.importId, 0, expect.objectContaining({
      to: 1, mailsFiled: 1, filesFiled: 2, filesSkipped: 1,
    }))
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(2, 'org_1', payload.importId, 1, expect.objectContaining({
      to: 2, itemsSkipped: 1,
      skippedSamples: [
        { mail: 'm', file: 'x.exe', reason: 'type' },
        { mail: 'IPM.Contact', file: null, reason: 'not_mail' },
      ],
    }))
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({ status: 'completed' }))
    expect(discardStaging).toHaveBeenCalledOnce()
    expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.completed', anchorId: 'folder_archive' })])
  })

  it('stops quietly when another slice already moved the cursor', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, contact], null))
    vi.mocked(repository.advanceMailImport).mockResolvedValueOnce(false)

    expect((await runMailImportSlice(session, payload, { last: false }, 'org_1')).done).toBe(true)
    expect(repository.advanceMailImport).toHaveBeenCalledOnce()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('does nothing for an import that already ended', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ status: 'cancelled', completedAt: new Date() }))
    expect((await runMailImportSlice(session, payload, { last: false }, 'org_1')).done).toBe(true)
    expect(readArchivePage).not.toHaveBeenCalled()
  })

  it('ends the import at once when the file is not an archive', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockRejectedValueOnce(new UnreadableArchiveError('not a readable Outlook archive'))

    expect((await runMailImportSlice(session, payload, { last: false }, 'org_1')).done).toBe(true)
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'unreadable', lastError: expect.stringMatching(/could not be read/),
    }))
    expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.failed' })])
  })

  it('ends the import when the quota is full', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new MailImportQuotaError())

    await runMailImportSlice(session, payload, { last: false }, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'quota',
    }))
  })

  it('throws a passing failure for the queue to retry, and ends the import on the last attempt', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValue(row())
    vi.mocked(readArchivePage).mockRejectedValue(new Error('the archive reader answered 502'))

    await expect(runMailImportSlice(session, payload, { last: false }, 'org_1')).rejects.toThrow(/502/)
    expect(emitInboxItems).not.toHaveBeenCalled()

    expect((await runMailImportSlice(session, payload, { last: true }, 'org_1')).done).toBe(true)
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'stopped', lastError: expect.stringMatching(/Repeated errors.*502/),
    }))
    vi.mocked(repository.findMailImport).mockReset()
    vi.mocked(readArchivePage).mockReset()
  })

  it('ends the import with a reason when the person who started it left', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    await runMailImportSlice(null, payload, { last: false }, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'requester_left',
    }))
  })

  it('makes the archive folder once and remembers it', async () => {
    const queued = row({ status: 'queued', rootFolderId: null, totalItems: null })
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(queued)
    vi.mocked(repository.updateMailImport).mockResolvedValueOnce({ ...queued, status: 'importing' })
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([], null, 0))

    await runMailImportSlice(session, payload, { last: false }, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued'], { status: 'importing' })
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['importing'], { rootFolderId: 'folder_archive' })
  })
})

describe('sweepStaleMailImports', () => {
  it('aborts an unfinished upload, fails an import without a job, and leaves one with a job', async () => {
    vi.mocked(repository.listStaleOpenImports).mockResolvedValueOnce([
      row({ id: 'a', status: 'uploading', uploadId: 'u1' }),
      row({ id: 'b', status: 'importing' }),
      row({ id: 'c', status: 'queued' }),
    ])
    vi.mocked(findOpenJobId).mockImplementation(async ({ matching }) => (matching.importId === 'c' ? 'job_c' : null))

    const result = await sweepStaleMailImports(new Date('2026-10-08T12:00:00Z'))
    expect(result).toEqual({ checked: 3, aborted: 1, failed: 1, waiting: 1, errors: 0 })
  })
})
