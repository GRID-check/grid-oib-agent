/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * Every S3 command of one kind that was actually sent.
 *
 * The single widening in this file, and it widens rather than narrows: `unknown`
 * plus a real `instanceof` test, so the compiler learns the type from the same
 * check the assertion makes. A cast to `PutObjectCommand` would have let the
 * mutation these helpers exist to catch — a PUT that never happens — read its
 * `.input` off `undefined` and fail with a TypeError instead of an assertion.
 */
const sentCommands = <T>(kind: abstract new (...args: never[]) => T): T[] =>
  s3Send.mock.calls
    .map(([command]) => command as unknown)
    .filter((command): command is T => command instanceof kind)

const onlyPut = (): PutObjectCommand => {
  const puts = sentCommands(PutObjectCommand)
  expect(puts, 'exactly one object is written per filed document').toHaveLength(1)
  return puts[0]
}

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

// The race test replaces the constant id stub above with a counter, because two
// racers need two document ids. Undoing it here rather than there keeps the
// stub from leaking into whatever test happens to run next.
afterEach(() => {
  vi.unstubAllGlobals()
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
   * THE ROW AND ITS OBJECT ARE THE SAME FILE.
   *
   * `admission.ts` exists to maintain one invariant — "a `documents` row implies
   * its object exists" — and it can only maintain it for the bucket and key it
   * is HANDED. This block is the half admission cannot check: that the bytes
   * PUT, the location admission was told about, and the location the row records
   * are one file, described identically in all three places.
   *
   * It is asserted here because the suite passed under three separate mutations
   * of this function, each of which ships a report nobody can open:
   *
   *   1. `Body: body` → `Body: Buffer.alloc(0)` — every filed report is a 0-byte
   *      `.docx` while its row advertises the real size, so the Files pane shows
   *      a plausible document and Word refuses to open it;
   *   2. the key given to `admitOrDiscard` ≠ the key PUT — the row points at no
   *      object at all, the download 404s, and the compensating delete on the
   *      audit-failure path removes some other key;
   *   3. `collectionName` dropped — the row belongs to no corpus, and every
   *      lookup that identifies a document by `(collectionName, filename)`
   *      (the internal document-file route the agent tier reads through) misses.
   *
   * None of the three is visible in a status code or a returned id, which is why
   * the correspondence has to be asserted rather than assumed.
   */
  describe('the row and its object are the same file', () => {
    it('PUTs the rendered bytes, whole, under the tenant bucket and the built key', async () => {
      await file()

      const put = onlyPut()
      const row = admittedRow()

      // The bytes the renderer produced, not a placeholder and not a truncation.
      // `fileSize` is recorded from the same buffer, so a row whose size does not
      // describe its object is unrepresentable rather than merely unlikely.
      expect(put.input.Body).toEqual(Buffer.from([1, 2, 3, 4, 5]))
      expect(row.fileSize).toBe(5)
      expect(put.input.ContentType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      expect(put.input.Bucket).toBe('grid-org-org-1')
      // The whole key, spelled out. `buildStorageKey` is mocked in this file, so
      // this pins the ARGUMENTS it was given — the org, the project, the folder
      // path the destination resolver chose, the document's own id, and the
      // generated filename — rather than the real naming rule, which has its own
      // spec.
      expect(put.input.Key).toBe(
        `org/org-1/project/proj-1/Berichte/doc/${row.id}/${row.filename}`,
      )
    })

    it('tells admission about the object it actually wrote', async () => {
      await file()

      const put = onlyPut()
      // Positional, because that is how admission reads them: bucket, key, row.
      // A mismatch here is the case admission cannot detect — it would dutifully
      // delete a key nothing was ever written to when the quota refuses, leaving
      // the real object orphaned and the refusal looking clean.
      expect(admitOrDiscard.mock.calls[0][0]).toBe(put.input.Bucket)
      expect(admitOrDiscard.mock.calls[0][1]).toBe(put.input.Key)
    })

    it('records that same location on the row', async () => {
      await file()

      const put = onlyPut()
      const row = admittedRow()
      // The columns every read path resolves bytes through. If they name a
      // different object than the one written, the document exists in the Files
      // pane, counts against the quota, and cannot be downloaded — and nothing
      // in the filing path fails.
      expect(row.storageKey).toBe(put.input.Key)
      expect(row.storageBucket).toBe(put.input.Bucket)
    })

    it('names the file the same way in the row as in the key', async () => {
      await file()

      const row = admittedRow()
      // `filename` is the join key to the object AND to the retrieval index's
      // chunks. The row's copy and the key's tail are written from one variable
      // today; this is what notices if they stop being.
      expect(row.filename).toMatch(/^brandschutz-strassenhauser-\d{4}-\d{2}-\d{2}\.docx$/)
      expect(row.storageKey?.endsWith(`/${row.filename}`)).toBe(true)
      // The rename column carries the human title; `filename` stays ASCII.
      expect(row.displayName).toBe('Brandschutz Straßenhäuser')
      expect(row.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
    })

    it('files the row into the project corpus it belongs to', async () => {
      await file()

      // Which corpus the row BELONGS to, not which one holds chunks for it —
      // nothing is ever indexed here. Dropping it is silent: the row files, the
      // report opens from the Files pane, and only the lookups that identify a
      // document by `(collectionName, filename)` come back empty.
      expect(admittedRow().collectionName).toBe('proj_abc')
    })
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

    /**
     * TWO TABS, ONE RUN.
     *
     * The probe above is a lookup, and a lookup cannot see a caller that has not
     * inserted yet. The filing write sits on a GET (`/api/jobs/async/job/{id}/
     * report`) that is re-fetched every time a tab is opened, so two tabs — or a
     * tab and a reload — run it concurrently: both probe, both miss, both render,
     * both PUT, both insert. Two rows, two objects, two quota charges, two audit
     * events for one multi-minute run.
     *
     * And the two are INDISTINGUISHABLE: `generatedFilename` is deterministic
     * (slug + date + extension), so they agree on filename, display name, size,
     * folder, author, run and second. `repository.ts` names that outcome as
     * "precisely the thing an office cannot untangle later" — an office that
     * cannot tell two reports apart keeps both, and somebody signs one of them.
     *
     * Migration 0064's partial unique index is what makes the second insert fail
     * instead of succeed; this is the recovery being graceful, the same shape
     * `getOrCreateProjectFolderByName` already has for the `Berichte` folder.
     *
     * The mocks below MODEL the race rather than hoping for an interleaving: the
     * first two probes answer "not filed" whatever order they run in, which is
     * exactly the window a lookup cannot close, and `admitOrDiscard` behaves as
     * the real one does — it rejects the second insert with a 23505 AND takes
     * that caller's object back, because it discards on any admission failure
     * and not only on a quota refusal (`admission.spec.ts` pins that).
     */
    it('files ONE document and leaves ONE object when two tabs file the same run at once', async () => {
      const filedByRun = new Map<string, NewDocument>()
      let probes = 0

      // Distinct document ids per call, overriding the shared constant stub.
      // Load-bearing: each caller mints its own uuid and therefore its own
      // storage key, so "the loser's object is deleted and the winner's is not"
      // is a real assertion rather than one key deleted and re-asserted.
      let minted = 0
      vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `doc-${++minted}` })

      findDocumentAuthoredByRun.mockImplementation(async (runId: string) => {
        // The first two probes are the two tabs, both of which run before either
        // has inserted. Forced rather than hoped for: an interleaving that
        // depended on microtask ordering would silently stop testing the race.
        if (++probes <= 2) return null
        const row = filedByRun.get(runId)
        return row ? { id: row.id, filename: row.filename, folderId: row.folderId } : null
      })

      admitOrDiscard.mockImplementation(async (bucket: string, key: string, row: NewDocument) => {
        const runId = row.authoredByRunId ?? ''
        if (!filedByRun.has(runId)) {
          filedByRun.set(runId, row)
          return
        }
        // What the real admission does with a rejected insert: take the bytes
        // back, then re-throw. The key is this caller's own, so the winner's
        // object is untouched.
        await s3Send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        throw Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uniq_documents_authored_run_per_project"',
          ),
          { code: '23505' },
        )
      })

      const [first, second] = await Promise.all([file(), file()])

      // One document, and both callers are told about the same one — the loser
      // must not 500 on somebody's finished report.
      expect(filedByRun.size).toBe(1)
      const winner = filedByRun.get('run_7')
      expect(first.documentId).toBe(winner?.id)
      expect(second.documentId).toBe(winner?.id)
      expect(first.filename).toBe(winner?.filename)
      expect(second.filename).toBe(winner?.filename)
      // Exactly one of the two filed; the other is told it was already filed.
      expect([first.alreadyFiled, second.alreadyFiled].sort()).toEqual([false, true])

      // Both racers wrote an object, and exactly the loser's was taken back. An
      // object left behind here is quota-INVISIBLE: the ledger counts rows, so
      // nothing would ever notice the bytes, and only a bucket-wide sweep could
      // find them.
      const puts = sentCommands(PutObjectCommand)
      const deletes = sentCommands(DeleteObjectCommand)
      expect(puts).toHaveLength(2)
      expect(deletes).toHaveLength(1)
      const surviving = puts
        .map((put) => put.input.Key)
        .filter((key) => key !== deletes[0].input.Key)
      expect(surviving).toEqual([winner?.storageKey])

      // One run, one audit event. A second `document.generated` for a document
      // this call did not file would put an act in the trail that never happened
      // — and the trail is what answers "who authorized this document".
      expect(recordAuditEventOrThrow).toHaveBeenCalledTimes(1)
      // Nothing to unfile: the loser never inserted a row.
      expect(deleteProjectDocument).not.toHaveBeenCalled()
    })

    it('re-throws a unique violation the re-probe cannot explain', async () => {
      // Cannot happen while 0064's index and `findDocumentAuthoredByRun` key on
      // the same three columns — which is why the migration derives one from the
      // other. If they ever drift, this is a violation with no winner to hand
      // back, and answering it with a made-up document id would be worse than
      // the 500.
      admitOrDiscard.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      )

      await expect(file()).rejects.toThrow('duplicate key')
      expect(recordAuditEventOrThrow).not.toHaveBeenCalled()
    })

    it('re-throws an admission failure that is not a unique violation', async () => {
      // A deadlock is not a race this function won or lost, and answering it
      // with "already filed" would report a document that does not exist.
      admitOrDiscard.mockRejectedValue(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      )

      await expect(file()).rejects.toThrow('deadlock detected')
      // One probe: the pre-flight one. A non-race failure must not be answered
      // by looking for a winner that was never created.
      expect(findDocumentAuthoredByRun).toHaveBeenCalledTimes(1)
    })

    it('looks the run up by its own id, scoped to the organization AND the project', async () => {
      // The project scope is the load-bearing half. The filing target comes
      // from the report request's own projectId, so an org-wide probe answered
      // "already filed" for a run whose report went to a DIFFERENT project —
      // handing back that project's document id and folder, so this project
      // silently never received the report and the caller's Öffnen/Zuweisen
      // pointed somewhere the reader may not even be.
      await file()
      expect(findDocumentAuthoredByRun).toHaveBeenCalledWith('run_7', 'org-1', 'proj-1', 'deep_research')
    })

    it('looks the run up by its PRODUCER too, so a run can owe more than one file', async () => {
      // Migration 0065. A run can produce several artifacts that are not
      // substitutes — a diagram is an SVG that previews and a PDF that gets
      // attached — and a probe blind to the producer answers "already filed"
      // for the second one, so the run files one artifact or the other and
      // never both. The probe and 0065's unique index key on the same four
      // columns; `documents.spec.ts` reads both files and fails when they
      // drift.
      await fileGeneratedDocument({
        session: SESSION,
        projectId: 'proj-1',
        producer: 'diagram_pdf',
        runId: 'run_7',
        title: 'Ablauf',
        render,
      })
      expect(findDocumentAuthoredByRun).toHaveBeenCalledWith('run_7', 'org-1', 'proj-1', 'diagram_pdf')
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
