/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const s3Send = vi.fn()
vi.mock('@/lib/s3', () => ({
  s3Client: { send: (...args: unknown[]) => s3Send(...args) },
  bucketAdminS3Client: {},
  buildStorageKey: (
    organizationId: string,
    projectId: string,
    documentId: string,
    filename: string,
    folderPath?: string | null,
  ) => `org/${organizationId}/project/${projectId}/${folderPath ?? ''}/doc/${documentId}/${filename}`,
}))

const ensureTenantBucketChecked = vi.fn()
vi.mock('@/lib/storage/bucket', () => ({
  ensureTenantBucketChecked: (...args: unknown[]) => ensureTenantBucketChecked(...args),
}))

const admitOrDiscard = vi.fn()
vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: (...args: unknown[]) => admitOrDiscard(...args),
}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))

const recordAuditEventOrThrow = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEventOrThrow: (...args: unknown[]) => recordAuditEventOrThrow(...args),
}))

const findProjectInOrg = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: (...args: unknown[]) => findProjectInOrg(...args),
}))

const getOrCreateProjectFolderByName = vi.fn()
vi.mock('@/lib/projects/folder-service', () => ({
  getOrCreateProjectFolderByName: (...args: unknown[]) => getOrCreateProjectFolderByName(...args),
}))

const findDocumentAuthoredByRun = vi.fn()
const deleteProjectDocument = vi.fn()
vi.mock('./repository', () => ({
  findDocumentAuthoredByRun: (...args: unknown[]) => findDocumentAuthoredByRun(...args),
  deleteProjectDocument: (...args: unknown[]) => deleteProjectDocument(...args),
}))

/**
 * The ingest dispatcher, mocked so that the DAY somebody imports it here the
 * spies below start firing instead of a real backend call going out silently.
 */
const dispatchDocument = vi.fn()
const dispatchIngest = vi.fn()
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: (...args: unknown[]) => dispatchDocument(...args),
  dispatchIngest: (...args: unknown[]) => dispatchIngest(...args),
}))

import { ForbiddenError, InsufficientStorageError, NotFoundError } from '@/lib/api/errors'
import type { NewDocument } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeProject } from '@/test-utils/db-fixtures'
import { AUDIT_SCHEMAS } from '@/lib/audit/schemas.mjs'
import {
  GENERATED_DOCUMENT_FOLDER_NAME,
  GENERATED_DOCUMENT_PRODUCERS,
  fileGeneratedDocument,
  generatedFilename,
  resolveGeneratedDocumentDestination,
} from './generated'

const SESSION = {
  userId: 'user-1',
  email: 'architektin@example.at',
  name: 'Architektin',
  accessToken: 'token',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'editor',
  permissions: ['project:documents:write'],
  featureFlags: null,
} as AuthorizedSession

const FOLDER = {
  id: 'folder-1',
  projectId: 'proj-1',
  parentId: null,
  name: GENERATED_DOCUMENT_FOLDER_NAME,
  path: GENERATED_DOCUMENT_FOLDER_NAME,
  createdAt: new Date('2026-08-20T00:00:00Z'),
  updatedAt: new Date('2026-08-20T00:00:00Z'),
}

const render = vi.fn(() => ({
  bytes: new Uint8Array([1, 2, 3, 4, 5]),
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}))

const file = () =>
  fileGeneratedDocument({
    session: SESSION,
    projectId: 'proj-1',
    producer: 'deep_research',
    runId: 'run_7',
    title: 'Brandschutz Straßenhäuser',
    render,
  })

/** The row `admitOrDiscard` was asked to insert. */
const admittedRow = (): NewDocument => admitOrDiscard.mock.calls[0][2] as NewDocument

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  requireProjectAccess.mockResolvedValue({ role: 'editor' })
  findDocumentAuthoredByRun.mockResolvedValue(null)
  findProjectInOrg.mockResolvedValue(makeProject({ id: 'proj-1', collectionName: 'proj_abc' }))
  getOrCreateProjectFolderByName.mockResolvedValue(FOLDER)
  ensureTenantBucketChecked.mockResolvedValue('grid-org-org-1')
  s3Send.mockResolvedValue({})
  admitOrDiscard.mockResolvedValue(undefined)
  recordAuditEventOrThrow.mockResolvedValue(undefined)
  deleteProjectDocument.mockResolvedValue(undefined)
  // Every ingest path this repo has — the BFF's own dispatch and the backend's
  // `/v1/ingest` — leaves over HTTP. Nothing filed here may make a request.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this spec'))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  // The setup's crypto polyfill has no `randomUUID`; the id value itself is
  // irrelevant here, only that the row and the audit target carry the same one.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'doc-uuid' })
  }
})

describe('fileGeneratedDocument', () => {
  it('files the bytes as an agent-authored row the quota ledger can see', async () => {
    const result = await file()

    expect(s3Send).toHaveBeenCalledTimes(1)
    expect(s3Send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand)
    // Admitted, never inserted directly: ADR-0042 has one admitting path, and a
    // row inserted around it is bytes the storage quota cannot count.
    expect(admitOrDiscard).toHaveBeenCalledTimes(1)

    const row = admittedRow()
    expect(row.authoredBy).toBe('agent')
    expect(row.authoredByProducer).toBe('deep_research')
    expect(row.authoredByRunId).toBe('run_7')
    expect(row.status).toBe('stored')
    // Provenance is not responsibility: the human who commissioned the run.
    expect(row.createdBy).toBe('user-1')
    expect(row.folderId).toBe('folder-1')
    expect(row.organizationId).toBe('org-1')
    expect(row.projectId).toBe('proj-1')
    expect(row.fileSize).toBe(5)
    // Never set, so the column default (`project`) decides — a generated report
    // is evidence the project can see, like every other file in it.
    expect(row.visibility).toBeUndefined()
    expect(result.alreadyFiled).toBe(false)
    expect(result.documentId).toBe(row.id)
  })

  it('lands in the destination the resolver names', async () => {
    await file()
    expect(getOrCreateProjectFolderByName).toHaveBeenCalledWith('proj-1', 'Berichte')
  })

  /**
   * THE OUROBOROS TEST.
   *
   * A document the agent wrote, embedded into the project corpus, is
   * retrievable as evidence FOR the agent: turn 3 asserts a fire-compartment
   * area, turn 9 cites it back under a green *Projektwissen* badge,
   * indistinguishable from a stamped Gutachten. The design's answer is that no
   * chunk ever exists, so self-citation is UNREPRESENTABLE rather than filtered
   * — which matters because the retrieval path's documented posture is
   * fail-OPEN (`rag-system-audit-2026-08.md` §9: a filter that failed to
   * translate, logged at DEBUG, and "produced a confident answer from an empty
   * knowledge layer, invisibly").
   *
   * So it is asserted at the DISPATCH SITE, not by inspecting retrieval output:
   * a filter that stops working still passes a retrieval-shaped test.
   */
  describe('the ouroboros test — a generated document is never ingested', () => {
    it('makes no ingest dispatch and no HTTP request at all while filing', async () => {
      await file()

      expect(dispatchDocument).not.toHaveBeenCalled()
      expect(dispatchIngest).not.toHaveBeenCalled()
      // The catch-all. `dispatchDocument` is only the dispatch site we know
      // about today; an ingest added through a new client, a fresh helper or a
      // hand-rolled POST still has to leave over fetch, and this rejects.
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('cannot acquire an ingest path without this spec failing', () => {
      // A source assertion on purpose. The two above prove nothing was
      // dispatched on THIS run; this one fails the moment the module gains the
      // ability to dispatch at all — including behind a flag, a branch, or a
      // condition no fixture in this file happens to hit.
      const source = readFileSync(new URL('./generated.ts', import.meta.url), 'utf8')
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code).not.toMatch(/dispatchDocument|dispatchIngest|\/v1\/ingest/)
      expect(code).not.toMatch(/from '(\.\/service|@\/lib\/documents\/service)'/)
    })
  })

  it('refuses a session without project:documents:write, before any byte is written', async () => {
    requireProjectAccess.mockRejectedValue(new ForbiddenError('project:documents:write required'))

    await expect(file()).rejects.toBeInstanceOf(ForbiddenError)

    expect(render).not.toHaveBeenCalled()
    expect(s3Send).not.toHaveBeenCalled()
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(recordAuditEventOrThrow).not.toHaveBeenCalled()
  })

  it('requires the write permission with the legacy umbrella the upload path accepts', async () => {
    await file()
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj-1', [
      'project:documents:write',
      'project:edit',
    ])
  })

  it('surfaces a quota refusal and leaves no row — admission has already taken the object back', async () => {
    const refusal = new InsufficientStorageError('no room', {
      quotaBytes: 10,
      usedBytes: 10,
      requestedBytes: 5,
    })
    admitOrDiscard.mockRejectedValue(refusal)

    await expect(file()).rejects.toBe(refusal)

    // The row was never inserted, so there is nothing to delete — and the
    // object deletion is admission's own, asserted in its spec.
    expect(deleteProjectDocument).not.toHaveBeenCalled()
    expect(recordAuditEventOrThrow).not.toHaveBeenCalled()
  })

  it('files a project that does not exist as a 404 rather than as an orphan object', async () => {
    findProjectInOrg.mockResolvedValue(null)
    await expect(file()).rejects.toBeInstanceOf(NotFoundError)
    expect(s3Send).not.toHaveBeenCalled()
  })

  describe('idempotency', () => {
    it('returns the existing document when this run was already filed', async () => {
      findDocumentAuthoredByRun.mockResolvedValue({
        id: 'doc-existing',
        filename: 'brandschutz-2026-08-20.docx',
        folderId: 'folder-1',
      })

      const result = await file()

      expect(result).toEqual({
        documentId: 'doc-existing',
        filename: 'brandschutz-2026-08-20.docx',
        folderId: 'folder-1',
        alreadyFiled: true,
      })
      // A report tab is re-opened freely; a second document per re-read would
      // be indistinguishable from a second run's report.
      expect(render).not.toHaveBeenCalled()
      expect(s3Send).not.toHaveBeenCalled()
      expect(admitOrDiscard).not.toHaveBeenCalled()
    })

    it('files the same run twice into one document', async () => {
      const first = await file()
      findDocumentAuthoredByRun.mockResolvedValue({
        id: first.documentId,
        filename: first.filename,
        folderId: first.folderId,
      })
      const second = await file()

      expect(second.documentId).toBe(first.documentId)
      expect(second.alreadyFiled).toBe(true)
      expect(admitOrDiscard).toHaveBeenCalledTimes(1)
    })

    it('looks the run up by its own id, scoped to the organization AND the project', async () => {
      // The project scope is the load-bearing half. The filing target comes
      // from the report request's own projectId, so an org-wide probe answered
      // "already filed" for a run whose report went to a DIFFERENT project —
      // handing back that project's document id and folder, so this project
      // silently never received the report and the caller's Öffnen/Zuweisen
      // pointed somewhere the reader may not even be.
      await file()
      expect(findDocumentAuthoredByRun).toHaveBeenCalledWith('run_7', 'org-1', 'proj-1')
    })
  })

  describe('audit', () => {
    it('emits document.generated with the agent actor and the run', async () => {
      await file()

      const event = recordAuditEventOrThrow.mock.calls[0][0]
      expect(event.action).toBe('document.generated')
      expect(event.actor).toEqual({
        type: 'agent',
        userId: 'user-1',
        email: 'architektin@example.at',
        runId: 'run_7',
      })
      expect(event.targetType).toBe('document')
      expect(event.targetId).toBe(admittedRow().id)
      expect(event.metadata).toMatchObject({ projectId: 'proj-1', producer: 'deep_research' })
    })

    it('unfiles the document when the audit write fails', async () => {
      const failure = new Error('audit rejected')
      recordAuditEventOrThrow.mockRejectedValue(failure)

      await expect(file()).rejects.toBe(failure)

      // "Who authorized this document" has no domain table to fall back on, so
      // a row nobody can account for must not be left looking filed.
      expect(deleteProjectDocument).toHaveBeenCalledWith(admittedRow().id, 'org-1', 'proj-1')
      const deletes = s3Send.mock.calls.filter(([command]) => command instanceof DeleteObjectCommand)
      expect(deletes).toHaveLength(1)
    })

    it('still fails the filing when the compensation itself fails', async () => {
      recordAuditEventOrThrow.mockRejectedValue(new Error('audit rejected'))
      deleteProjectDocument.mockRejectedValue(new Error('database gone'))

      // The audit failure, not the cleanup's — the caller is told the thing it
      // can act on, and the orphan is logged for the purge.
      await expect(file()).rejects.toThrow('audit rejected')
    })
  })
})

describe('resolveGeneratedDocumentDestination', () => {
  it('returns the fixed Berichte folder for every producer there is', () => {
    for (const producer of GENERATED_DOCUMENT_PRODUCERS) {
      expect(resolveGeneratedDocumentDestination(producer)).toEqual({ folderName: 'Berichte' })
    }
  })
})

describe('generatedFilename', () => {
  const day = new Date('2026-08-20T11:00:00Z')

  it('transliterates a German title into an ASCII stem with the date', () => {
    expect(generatedFilename('Brandschutz Straßenhäuser', 'application/pdf', day)).toBe(
      'brandschutz-strassenhauser-2026-08-20.pdf',
    )
  })

  it('picks the extension from the content type', () => {
    expect(
      generatedFilename(
        'Bericht',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        day,
      ),
    ).toBe('bericht-2026-08-20.docx')
  })

  it('says so rather than lying about a type it does not know', () => {
    expect(generatedFilename('Bericht', 'application/x-unknown', day)).toBe('bericht-2026-08-20.bin')
  })

  it('never emits an empty stem', () => {
    expect(generatedFilename('   ***   ', 'application/pdf', day)).toBe('piloti-2026-08-20.pdf')
  })
})

describe('the audit event this feature depends on', () => {
  /**
   * The bug this pins was silent and total: `fileGeneratedDocument` emitted a
   * `producer` metadata key that `schemas.mjs` did not register. schemas.mjs's
   * own header says a schema with the wrong keys rejects events exactly like a
   * missing one — and because THIS action uses the throwing emitter, a
   * rejection does not lose an audit line, it unfiles the document the line was
   * about. Every commissioned report was filed and immediately deleted, and the
   * user saw a report with no file and no error.
   *
   * A unit test that mocks the emitter cannot see that. This asserts the emit
   * against the REGISTRY, which is the only place the two facts meet.
   */
  it('emits only metadata keys the registry declares', async () => {
    await file()

    const [event] = recordAuditEventOrThrow.mock.calls[0] as [
      { action: keyof typeof AUDIT_SCHEMAS; metadata?: Record<string, unknown> },
    ]
    // Narrowed with `in` rather than cast: some actions register no metadata
    // at all, and widening the union to make the lookup easy would switch off
    // the very checking this test exists to perform.
    const schema = AUDIT_SCHEMAS[event.action]
    const registered = 'metadata' in schema ? Object.keys(schema.metadata) : []

    // Every key the emit sends must be declared; an undeclared one is a
    // rejected event, which for this action is a deleted document.
    expect(Object.keys(event.metadata ?? {}).length).toBeGreaterThan(0)
    for (const key of Object.keys(event.metadata ?? {})) {
      expect(registered).toContain(key)
    }
  })
})

describe('taking a document back when its audit write fails', () => {
  /**
   * Both compensating steps used to share one `try`, so a failure of the FIRST
   * skipped the second entirely — leaving the object behind for a row that no
   * longer existed, or, in the case that matters, leaving BOTH behind: a filed,
   * quota-charged, visible „Von Piloti erstellt" document with no audit record
   * at all. The ordering (row first) is still right; coupling the second step's
   * execution to the first step's success never was.
   */
  it('still takes the object back when the ROW delete fails', async () => {
    recordAuditEventOrThrow.mockRejectedValueOnce(new Error('audit rejected'))
    deleteProjectDocument.mockRejectedValueOnce(new Error('row delete failed'))

    await expect(file()).rejects.toThrow('audit rejected')

    const deletes = s3Send.mock.calls.filter(
      ([command]) => (command as { constructor: { name: string } }).constructor.name === 'DeleteObjectCommand',
    )
    expect(deletes).toHaveLength(1)
  })
})
