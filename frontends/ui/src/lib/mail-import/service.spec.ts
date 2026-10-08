/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/documents/shelf-authz', () => ({ requireShelfWrite: vi.fn() }))
vi.mock('@/lib/storage/service', () => ({ assertWithinStorageQuota: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn(async () => ({ jobId: 'job_1' })) }))
vi.mock('./staging', () => ({
  stagingBucket: vi.fn(async () => 'grid-org-o1'),
  stagingKey: (org: string, project: string, id: string) => `org/${org}/project/${project}/mail-imports/${id}/archive`,
  beginStagedUpload: vi.fn(async () => 'u1'),
  stagedArchiveSize: vi.fn(async () => null),
  isNoSuchUpload: (error: unknown) => (error as { name?: string }).name === 'NoSuchUpload',
  putStagedPart: vi.fn(),
  listStagedParts: vi.fn(async () => []),
  completeStagedUpload: vi.fn(),
  abortStagedUpload: vi.fn(),
  deleteStagedArchive: vi.fn(),
}))
vi.mock('./repository', () => ({
  insertMailImport: vi.fn(async (values: object) => ({ ...row(), ...values })),
  findMailImport: vi.fn(),
  listProjectMailImports: vi.fn(async () => []),
  updateMailImport: vi.fn(async (_org: string, _id: string, _from: unknown, patch: object) => ({ ...row(), ...patch })),
}))

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { MAIL_IMPORT_PART_BYTES } from './config'
import * as repository from './repository'
import {
  cancelMailImport,
  completeMailImportUpload,
  expectedPartSize,
  missingParts,
  putMailImportPart,
  startMailImport,
} from './service'
import * as staging from './staging'

const PART = MAIL_IMPORT_PART_BYTES

const session: AuthorizedSession = {
  userId: 'user_anna',
  email: 'anna@buero.test',
  name: 'Anna',
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

function row(overrides: Partial<MailImport> = {}): MailImport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org_1',
    projectId: '22222222-2222-4222-8222-222222222222',
    userId: 'user_anna',
    userEmail: 'anna@buero.test',
    filename: 'Büro 2019.pst',
    sizeBytes: PART * 2 + 10,
    status: 'uploading',
    stagingBucket: 'grid-org-o1',
    stagingKey: 'org/o1/mail-imports/i1/archive',
    uploadId: 'u1',
    stagingDeletedAt: null,
    rootFolderId: null,
    totalItems: null,
    nextPosition: 0,
    inflightPosition: null,
    inflightFolderId: null,
    mailsFiled: 0,
    filesFiled: 0,
    itemsSkipped: 0,
    filesSkipped: 0,
    skippedSamples: [],
    failureStreak: 0,
    errorCode: null,
    lastError: null,
    createdAt: new Date('2026-10-08T10:00:00Z'),
    updatedAt: new Date('2026-10-08T10:00:00Z'),
    completedAt: null,
    ...overrides,
  }
}

const PROJECT = row().projectId
const IMPORT = row().id

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'false')
  vi.stubEnv('GRID_MAIL_IMPORT_ENABLED', 'true')
})

describe('the part arithmetic', () => {
  it('sends full parts and one short last part', () => {
    const size = PART * 2 + 10
    expect(expectedPartSize(size, 1)).toBe(PART)
    expect(expectedPartSize(size, 3)).toBe(10)
    expect(() => expectedPartSize(size, 4)).toThrow()
    expect(() => expectedPartSize(size, 0)).toThrow()
  })

  it('names a part that is absent or the wrong size as missing', () => {
    const size = PART * 2 + 10
    expect(missingParts(size, [{ partNumber: 1, size: PART, etag: 'a' }, { partNumber: 3, size: 9, etag: 'c' }])).toEqual([2, 3])
  })
})

describe('startMailImport', () => {
  it('refuses when the deployment has not switched the import on', async () => {
    vi.stubEnv('GRID_MAIL_IMPORT_ENABLED', '')
    await expect(startMailImport(session, PROJECT, { filename: 'a.pst', sizeBytes: 10 })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('takes only Outlook archives, and only up to the ceiling', async () => {
    await expect(startMailImport(session, PROJECT, { filename: 'a.zip', sizeBytes: 10 })).rejects.toThrow(/Outlook/)
    vi.stubEnv('GRID_MAIL_IMPORT_MAX_BYTES', '100')
    await expect(startMailImport(session, PROJECT, { filename: 'a.pst', sizeBytes: 101 })).rejects.toThrow(/maximum/)
  })

  it('refuses a second open import of the same person in the project', async () => {
    vi.mocked(repository.listProjectMailImports).mockResolvedValueOnce([row({ status: 'importing' })])
    await expect(startMailImport(session, PROJECT, { filename: 'b.ost', sizeBytes: 10 })).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses at the database what the read missed: two tabs starting at once', async () => {
    vi.mocked(repository.insertMailImport).mockResolvedValueOnce(null)
    await expect(startMailImport(session, PROJECT, { filename: 'b.ost', sizeBytes: 10 })).rejects.toBeInstanceOf(ConflictError)
    expect(staging.beginStagedUpload).not.toHaveBeenCalled()
  })

  it('stages the archive inside the project prefix, after the row exists', async () => {
    const plan = await startMailImport(session, PROJECT, { filename: 'Büro 2019.pst', sizeBytes: PART * 2 + 10 })
    expect(vi.mocked(repository.insertMailImport).mock.calls[0][0].stagingKey).toMatch(
      new RegExp(`^org/org_1/project/${PROJECT}/mail-imports/`),
    )
    expect(staging.beginStagedUpload).toHaveBeenCalledOnce()
    expect(plan.partCount).toBe(3)
    expect(plan.uploadedParts).toEqual([])
    expect(plan.import).toMatchObject({ status: 'uploading', ownedByViewer: true, cancellable: true })
  })
})

describe('putMailImportPart', () => {
  it('refuses a part of the wrong size before writing it', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    const request = new Request('http://x', { method: 'PUT', body: new Uint8Array(11) })
    await expect(putMailImportPart(session, PROJECT, IMPORT, 3, request)).rejects.toThrow(/must be 10 bytes/)
    expect(staging.putStagedPart).not.toHaveBeenCalled()
  })

  it("refuses a part of somebody else's import as not found", async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ userId: 'user_other' }))
    const request = new Request('http://x', { method: 'PUT', body: new Uint8Array(10) })
    await expect(putMailImportPart(session, PROJECT, IMPORT, 3, request)).rejects.toThrow(/not found/)
  })

  it('writes an exact part through', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    const request = new Request('http://x', { method: 'PUT', body: new Uint8Array(10) })
    await expect(putMailImportPart(session, PROJECT, IMPORT, 3, request)).resolves.toEqual({ partNumber: 3 })
    expect(staging.putStagedPart).toHaveBeenCalledWith(expect.anything(), 'u1', 3, expect.any(Uint8Array))
  })
})

describe('completeMailImportUpload', () => {
  it('refuses while a part is missing, naming it', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(staging.listStagedParts).mockResolvedValueOnce([{ partNumber: 1, size: PART, etag: 'a' }])
    await expect(completeMailImportUpload(session, PROJECT, IMPORT)).rejects.toMatchObject({
      details: { missingParts: [2, 3] },
    })
    expect(staging.completeStagedUpload).not.toHaveBeenCalled()
  })

  it('reads a join whose answer was lost as done, when the archive is there at its size', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(staging.listStagedParts).mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }))
    vi.mocked(staging.stagedArchiveSize).mockResolvedValueOnce(PART * 2 + 10)

    const view = await completeMailImportUpload(session, PROJECT, IMPORT)
    expect(staging.completeStagedUpload).not.toHaveBeenCalled()
    expect(view.status).toBe('queued')
    expect(enqueueJob).toHaveBeenCalledOnce()
  })

  it('joins the parts, queues the import and enqueues its job as bulk work', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(staging.listStagedParts).mockResolvedValueOnce([
      { partNumber: 1, size: PART, etag: 'a' },
      { partNumber: 2, size: PART, etag: 'b' },
      { partNumber: 3, size: 10, etag: 'c' },
    ])
    vi.mocked(repository.updateMailImport).mockResolvedValueOnce(row({ status: 'queued', uploadId: null }))

    const view = await completeMailImportUpload(session, PROJECT, IMPORT)
    expect(staging.completeStagedUpload).toHaveBeenCalledOnce()
    expect(view.status).toBe('queued')
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mail_import',
        organizationId: 'org_1',
        payload: expect.objectContaining({ importId: IMPORT, projectId: PROJECT }),
      }),
    )
  })
})

describe('cancelMailImport', () => {
  it("lets nobody but the owner or a project administrator cancel", async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ userId: 'user_other' }))
    await expect(cancelMailImport(session, PROJECT, IMPORT)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it("lets a project administrator cancel a colleague's import, and says so in the view", async () => {
    const admin = { ...session, userId: 'user_admin', permissions: ['org:projects:administer'] }
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ status: 'importing' }))
    vi.mocked(repository.updateMailImport)
      .mockResolvedValueOnce(row({ status: 'cancelled', completedAt: new Date() }))
    const view = await cancelMailImport(admin, PROJECT, IMPORT)
    expect(view).toMatchObject({ status: 'cancelled', ownedByViewer: false })
  })

  it('aborts the staged upload of a cancelled send', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(repository.updateMailImport).mockResolvedValueOnce(row({ status: 'cancelled', completedAt: new Date() }))
    const view = await cancelMailImport(session, PROJECT, IMPORT)
    expect(view.status).toBe('cancelled')
    expect(staging.abortStagedUpload).toHaveBeenCalledWith(expect.anything(), 'u1')
    expect(staging.deleteStagedArchive).toHaveBeenCalledOnce()
  })

  it('leaves an ended import as it is', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ status: 'completed', completedAt: new Date() }))
    await cancelMailImport(session, PROJECT, IMPORT)
    expect(repository.updateMailImport).not.toHaveBeenCalled()
  })
})
