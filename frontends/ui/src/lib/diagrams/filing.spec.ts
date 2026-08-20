/**
 * @vitest-environment node
 */
/**
 * One diagram, two files, one admitting path.
 *
 * This spec runs the REAL `fileGeneratedDocument` with its infrastructure
 * mocked, rather than mocking the filing service itself. That is deliberate:
 * every claim worth making here — the bytes are admitted through the quota, the
 * rows say a machine wrote them, nothing is ever dispatched to the index — is a
 * property of what reaches `admitOrDiscard`, and a mocked filing service would
 * let all three be false while the assertions passed.
 *
 * The ingest dispatcher is mocked too, so that the day somebody imports it into
 * this path the spy below starts firing instead of a real backend call going
 * out silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PutObjectCommand } from '@aws-sdk/client-s3'

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
  ) => `org/${organizationId}/project/${projectId}/doc/${documentId}/${filename}`,
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
vi.mock('@/lib/documents/repository', () => ({
  findDocumentAuthoredByRun: (...args: unknown[]) => findDocumentAuthoredByRun(...args),
  deleteProjectDocument: (...args: unknown[]) => deleteProjectDocument(...args),
}))

const dispatchDocument = vi.fn()
const dispatchIngest = vi.fn()
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: (...args: unknown[]) => dispatchDocument(...args),
  dispatchIngest: (...args: unknown[]) => dispatchIngest(...args),
}))

import type { NewDocument } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeProject } from '@/test-utils/db-fixtures'
import { fileDiagramDocuments } from './filing'

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

const SOURCE = 'graph TD\n  Einreichung --> Bauverhandlung --> Baubewilligung'
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 90">' +
  '<rect x="10" y="10" width="80" height="40" fill="#eef" stroke="#334"/>' +
  '<text x="20" y="35" font-size="11" fill="#111">Einreichung</text>' +
  '</svg>'

const file = (overrides: Partial<Parameters<typeof fileDiagramDocuments>[0]> = {}) =>
  fileDiagramDocuments({
    session: SESSION,
    projectId: 'proj-1',
    runId: 'msg_42-1a2b3c4d',
    title: 'Ablauf Einreichung',
    sourceKind: 'mermaid',
    source: SOURCE,
    svg: SVG,
    marking: 'Von Piloti erstellt — KI-generiert, nicht geprüft.',
    ...overrides,
  })

/** Every row handed to admission, in call order. */
function admitted(): NewDocument[] {
  return admitOrDiscard.mock.calls.map((call) => call[2] as NewDocument)
}

beforeEach(() => {
  vi.clearAllMocks()
  // The setup's crypto polyfill has no `randomUUID`; the ids themselves are
  // never asserted on, only that the two rows get DIFFERENT ones — which is the
  // point of counting here rather than returning a constant.
  let minted = 0
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `doc-${++minted}` })
  requireProjectAccess.mockResolvedValue(undefined)
  findDocumentAuthoredByRun.mockResolvedValue(null)
  findProjectInOrg.mockResolvedValue(makeProject({ id: 'proj-1', name: 'Straßenhäuser' }))
  getOrCreateProjectFolderByName.mockResolvedValue({
    id: 'folder-1',
    projectId: 'proj-1',
    parentId: null,
    name: 'Berichte',
    path: 'Berichte',
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
  })
  ensureTenantBucketChecked.mockResolvedValue('bucket-org-1')
  s3Send.mockResolvedValue({})
  admitOrDiscard.mockResolvedValue(undefined)
  recordAuditEventOrThrow.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('a diagram is two files', () => {
  it('files an SVG and a PDF, as two rows of two producers', async () => {
    // Not substitutes: the SVG previews in the Files pane today and carries the
    // diagram's own source for regeneration; the PDF is what gets attached to
    // an Einreichung. One row cannot be both — a row has one storage key and one
    // content type — and a sibling object would be bytes with no row, which is
    // exactly what ADR-0042 says the quota ledger cannot see.
    const filed = await file()

    expect(admitted().map((row) => row.authoredByProducer)).toEqual(['diagram_svg', 'diagram_pdf'])
    expect(admitted().map((row) => row.contentType)).toEqual(['image/svg+xml', 'application/pdf'])
    expect(filed.svg.documentId).not.toBe(filed.pdf.documentId)
  })

  it('gives both rows the same run, which is what makes them one diagram', async () => {
    // Migration 0065's key is (organization, project, run, producer). The run is
    // shared so the two rows can be recognised as artifacts of one drawing; the
    // producer is what lets both exist. Synthetic per-artifact run ids would
    // have needed no migration and would have made `authored_by_run_id` join
    // back to nothing.
    await file()
    expect(admitted().map((row) => row.authoredByRunId)).toEqual(['msg_42-1a2b3c4d', 'msg_42-1a2b3c4d'])
    expect(findDocumentAuthoredByRun.mock.calls.map((call) => call[3])).toEqual([
      'diagram_svg',
      'diagram_pdf',
    ])
  })

  it('names both files after the diagram, with the extension telling them apart', async () => {
    await file()
    expect(admitted().map((row) => row.filename)).toEqual([
      expect.stringMatching(/^ablauf-einreichung-\d{4}-\d{2}-\d{2}\.svg$/),
      expect.stringMatching(/^ablauf-einreichung-\d{4}-\d{2}-\d{2}\.pdf$/),
    ])
  })
})

describe('every rule of the existing feature still applies', () => {
  it('marks both rows as written by a machine, on the commissioning human', async () => {
    // Provenance is not responsibility (ADR-0047): `authoredBy` says whose hand
    // wrote the bytes, `createdBy` stays the person whose permission authorized
    // the write and whom the audit and the export can name.
    await file()
    for (const row of admitted()) {
      expect(row.authoredBy).toBe('agent')
      expect(row.createdBy).toBe('user-1')
    }
  })

  it('leaves both rows at `stored`, never at pending', async () => {
    // Terminal and honest: the bytes are here and indexing was deliberately
    // skipped. `pending` would render a spinner waiting on a job nobody
    // dispatched, on a row that is already at rest.
    await file()
    expect(admitted().map((row) => row.status)).toEqual(['stored', 'stored'])
  })

  it('files both into the project, with zero assignees implied by the row', async () => {
    // `Unvergeben` is the promotion primitive: nothing here writes an
    // assignment, so the human act that makes the drawing somebody's work
    // product is still `Zuweisen`.
    await file()
    for (const row of admitted()) {
      expect(row.projectId).toBe('proj-1')
      expect(row.folderId).toBe('folder-1')
    }
    expect(admitOrDiscard.mock.calls.some((call) => 'assignees' in (call[2] as object))).toBe(false)
  })

  it('never dispatches either file to the index', async () => {
    // The ouroboros rule. No chunks exist, so a diagram Piloti drew cannot come
    // back to Piloti as *Projektwissen*. Asserted here as well as at the
    // dispatch site because this is a NEW caller, and the general lesson is
    // that an invariant enforced at each caller is one each caller can forget.
    await file()
    expect(dispatchDocument).not.toHaveBeenCalled()
    expect(dispatchIngest).not.toHaveBeenCalled()
  })

  it('asks for the write permission before storing a byte', async () => {
    requireProjectAccess.mockRejectedValueOnce(new Error('forbidden'))
    await expect(file()).rejects.toThrow('forbidden')
    expect(s3Send).not.toHaveBeenCalled()
  })

  it('records an audit event per filed row', async () => {
    await file()
    expect(recordAuditEventOrThrow).toHaveBeenCalledTimes(2)
    expect(
      recordAuditEventOrThrow.mock.calls.map((call) => call[0].metadata.producer),
    ).toEqual(['diagram_svg', 'diagram_pdf'])
  })
})

describe('what is stored is not what was sent', () => {
  it('stores the SVG this codebase wrote, from its allow-list', async () => {
    // The client's bytes are never stored verbatim. `svg.ts` re-serialises the
    // parsed tree, so an attribute nobody thought to refuse cannot reach the
    // stored object even if the deny-list has a gap.
    await file({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<rect width="10" height="10" fill="#eee" data-sneaky="x"/></svg>',
    })
    const body = s3Send.mock.calls[0][0] as PutObjectCommand
    const stored = Buffer.from(body.input.Body as Uint8Array).toString('utf8')
    expect(stored).toContain('fill="#eee"')
    expect(stored).not.toContain('data-sneaky')
  })

  it('puts the diagram source inside the stored SVG', async () => {
    // Where the source lives, and why: it has to travel WITH the artifact,
    // because the person who needs to regenerate the drawing is the person who
    // has the file. Not a third row (a `.mmd` nobody asked for, with its own
    // quota and its own `Zuweisen`), not a column (which would not survive the
    // download), not the audit record (a compliance trail is not a store).
    await file()
    const body = s3Send.mock.calls[0][0] as PutObjectCommand
    const stored = Buffer.from(body.input.Body as Uint8Array).toString('utf8')
    expect(stored).toContain('<metadata data-grid-diagram-source="mermaid">')
    expect(stored).toContain('Bauverhandlung')
  })

  it('refuses the whole submission before anything is authorized or stored', async () => {
    // A refusal is the client's fault and the client can fix it. Refusing here
    // rather than after the SVG has landed is what keeps a rejected diagram from
    // leaving half a diagram in the project.
    await expect(
      file({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>x()</script></svg>' }),
    ).rejects.toThrow(/script-element/)
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(admitOrDiscard).not.toHaveBeenCalled()
  })
})

describe('a partial filing is recoverable rather than rolled back', () => {
  it('keeps the SVG when the PDF cannot be filed, and says so by throwing', async () => {
    // The SVG is the half that carries the source, so it is the half worth
    // keeping — and `fileGeneratedDocument` is idempotent per (run, producer),
    // which is what makes the retry the compensation: filing again finds the
    // SVG already filed and files only the PDF.
    admitOrDiscard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('quota'))
    await expect(file()).rejects.toThrow('quota')
    expect(admitted().map((row) => row.authoredByProducer)).toEqual(['diagram_svg', 'diagram_pdf'])
  })

  it('files only the missing half on a retry', async () => {
    findDocumentAuthoredByRun.mockImplementation((_run: string, _org: string, _project: string, producer: string) =>
      producer === 'diagram_svg'
        ? Promise.resolve({ id: 'doc-svg', filename: 'ablauf.svg', folderId: 'folder-1' })
        : Promise.resolve(null),
    )
    const filed = await file()
    expect(filed.svg.alreadyFiled).toBe(true)
    expect(filed.pdf.alreadyFiled).toBe(false)
    expect(admitted().map((row) => row.authoredByProducer)).toEqual(['diagram_pdf'])
  })
})
