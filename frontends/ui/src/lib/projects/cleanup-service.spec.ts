/**
 * @vitest-environment node
 *
 * „Ausmisten" (ADR-0088): the proposal looks only at what the closer may read
 * and write, sends the model metadata and nothing else, falls back to the rules
 * when the model fails, and the confirmation puts exactly what the person chose
 * into the Papierkorb, one subfolder per source folder, audited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireFolderWrite: vi.fn(),
  getProjectFolderAccess: vi.fn(),
  listProjectFolders: vi.fn(),
  listProjectDocumentPage: vi.fn(),
  summarizeDocumentVersions: vi.fn(),
  reconcileDocumentStatuses: vi.fn(),
  createProjectFolder: vi.fn(),
  moveDocumentToFolder: vi.fn(),
  moveFolderToBin: vi.fn(),
  restoreFolderFromBin: vi.fn(),
  deleteEmptyCreatedFolder: vi.fn(),
  recordAuditEvent: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: mocks.requireProjectAccess }))
vi.mock('@/lib/authz/folder-access', () => ({
  DOCUMENT_WRITE_PERMISSIONS: ['project:documents:write', 'project:edit'],
  getProjectFolderAccess: mocks.getProjectFolderAccess,
  requireFolderWrite: mocks.requireFolderWrite,
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend' }))
vi.mock('@/lib/documents/repository', () => ({ listProjectDocumentPage: mocks.listProjectDocumentPage }))
vi.mock('@/lib/documents/lifecycle', () => ({ summarizeDocumentVersions: mocks.summarizeDocumentVersions }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: mocks.reconcileDocumentStatuses }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentToFolder: mocks.moveDocumentToFolder }))
vi.mock('@/lib/documents/shelf-folders', () => ({ FOLDER_NAME_TAKEN: 'A folder with this name already exists here.' }))
vi.mock('./folder-bin', () => ({ moveFolderToBin: mocks.moveFolderToBin, restoreFolderFromBin: mocks.restoreFolderFromBin }))
vi.mock('./cleanup-repository', () => ({ deleteEmptyCreatedFolder: mocks.deleteEmptyCreatedFolder }))
// The closer reads the project as a member (ADR-0083): screened files, and the held ones they uploaded.
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({
  shelfReaderFor: vi.fn(async () => ({ kind: 'member', userId: 'user_pl' })),
}))
vi.mock('./folder-service', () => ({ createProjectFolder: mocks.createProjectFolder, listProjectFolders: mocks.listProjectFolders }))
vi.mock('./repository', () => ({ findProjectInOrg: vi.fn(async () => ({ id: 'p1', collectionName: 'proj_1' })) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: mocks.recordAuditEvent }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { UpstreamError } from '@/lib/api/errors'
import { confirmCleanup, proposeCleanup } from './cleanup-service'

const session: AuthorizedSession = {
  userId: 'user_pl',
  email: 'pl@buero.at',
  name: 'PL',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const FOLDER = { plaene: 'f-plaene', vertraege: 'f-vertraege', honorare: 'f-honorare' }
const UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

const row = (n: number, filename: string, folderId: string | null, extra: Record<string, unknown> = {}) => ({
  id: UUID(n),
  filename,
  displayName: null,
  folderId,
  contentType: 'application/pdf',
  authoredBy: 'user',
  createdBy: 'user_pl',
  status: 'completed',
  screeningOutcome: 'clean',
  contentHash: null,
  screenedHash: null,
  createdAt: new Date(`2026-0${n}-01T00:00:00Z`),
  ...extra,
})

/** Pläne: write. Verträge: read only. Honorare: hidden. */
const ROWS = [
  row(1, 'Einreichplan_v1.pdf', FOLDER.plaene),
  row(2, 'Einreichplan_v2.pdf', FOLDER.plaene),
  row(3, 'Kopie von Werkvertrag.pdf', FOLDER.vertraege),
  row(4, 'Honorarnote alt.pdf', FOLDER.honorare),
  row(5, '~$Baubeschreibung.docx', null),
  row(6, 'Baubeschreibung.docx', null, { summary: 'Baubeschreibung für die Einreichung' }),
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireProjectAccess.mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
  mocks.getProjectFolderAccess.mockResolvedValue({
    hiddenFolderIds: new Set([FOLDER.honorare]),
    isVisible: (folderId: string | null) => folderId !== FOLDER.honorare,
    levelOf: (folderId: string | null) => (folderId === FOLDER.vertraege ? 'read' : folderId === FOLDER.honorare ? 'none' : 'write'),
  })
  mocks.listProjectFolders.mockResolvedValue([
    { id: FOLDER.plaene, path: 'Pläne' },
    { id: FOLDER.vertraege, path: 'Verträge' },
  ])
  mocks.reconcileDocumentStatuses.mockImplementation(async (rows: unknown[]) => rows)
  mocks.summarizeDocumentVersions.mockResolvedValue(new Map())
  mocks.createProjectFolder.mockImplementation(async ({ parentId }: { parentId: string | null }) => ({
    ok: true,
    folder: { id: `bin-holder-${parentId ?? 'root'}` },
  }))
  mocks.moveDocumentToFolder.mockResolvedValue({ ok: true })
  mocks.moveFolderToBin.mockResolvedValue({})
  mocks.restoreFolderFromBin.mockResolvedValue({})
  mocks.deleteEmptyCreatedFolder.mockResolvedValue(true)
  screening({})
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

/**
 * The content gate's outcome per document number, on the rows the listing
 * returns; every other document passed (`clean`). The listing already leaves
 * out what is hidden, as the real repository does.
 */
function screening(
  outcomes: Record<number, { status?: string; screeningOutcome: string | null; screenedHash?: string; authoredBy?: string }>
) {
  const byId = new Map(Object.entries(outcomes).map(([n, outcome]) => [UUID(Number(n)), outcome]))
  mocks.listProjectDocumentPage.mockResolvedValue({
    rows: ROWS.filter((r) => r.folderId !== FOLDER.honorare).map((r) => ({ ...r, ...(byId.get(r.id) ?? {}) })),
    nextCursor: null,
  })
}

const modelAnswers = (candidates: Array<{ id: string; category: string; reason: string }>) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidates, model: 'm', error: null }), { status: 200 }))

describe('proposeCleanup', () => {
  it('sends the model only the documents the closer may write, and only their metadata', async () => {
    modelAnswers([])
    await proposeCleanup(session, 'p1', 'de')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { documents: Array<Record<string, unknown>> }
    expect(body.documents.map((doc) => doc.filename)).toEqual([
      'Einreichplan_v1.pdf',
      'Einreichplan_v2.pdf',
      '~$Baubeschreibung.docx',
      'Baubeschreibung.docx',
    ])
    // Read-only Verträge and hidden Honorare never leave the BFF.
    expect(JSON.stringify(body)).not.toMatch(/Werkvertrag|Honorarnote/)
    const keys = new Set(body.documents.flatMap((doc) => Object.keys(doc)))
    expect([...keys].sort()).toEqual(
      ['authored_by', 'content_type', 'filename', 'folder_path', 'id', 'summary', 'tags', 'uploaded_at', 'version_state'].sort()
    )
  })

  it('sends the model nothing the content gate has not passed, and leaves quarantined documents out entirely', async () => {
    screening({
      1: { screeningOutcome: 'released' },
      2: { screeningOutcome: 'clean', screenedHash: 'sha256:earlier' },
      5: { status: 'processing', screeningOutcome: null },
      6: { status: 'quarantined', screeningOutcome: 'quarantined' },
    })
    modelAnswers([])
    const proposal = await proposeCleanup(session, 'p1', 'de')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { documents: Array<Record<string, unknown>> }
    // Released by a reviewer: passed. Still in flight, a verdict about earlier
    // bytes, quarantined: held, and never reach the model.
    expect(body.documents.map((doc) => doc.filename)).toEqual(['Einreichplan_v1.pdf'])
    expect(JSON.stringify(body)).not.toMatch(/Einreichplan_v2|Baubeschreibung/)
    // The rules still look at what the gate has not passed; the quarantined one is not proposed at all.
    expect(proposal.considered).toBe(3)
    expect(proposal.items.map((item) => item.filename)).toEqual(['~$Baubeschreibung.docx', 'Einreichplan_v1.pdf'])
    await expect(
      confirmCleanup(session, 'p1', { documentIds: [UUID(6)], proposedIds: [], aiUsed: true })
    ).rejects.toMatchObject({ status: 400, details: { reason: 'not-writable' } })
  })

  it('names to the model every file the gate passed, by the one definition of screened', async () => {
    screening({
      // Read by its name alone (a scan): passes, as it passes to every member.
      1: { screeningOutcome: 'partial' },
      2: { screeningOutcome: 'unchecked' },
      // Indexed with screening switched off: no verdict at a settled status.
      5: { status: 'completed', screeningOutcome: null },
      // Piloti's own report carries no verdict and was never an upload.
      6: { authoredBy: 'agent', screeningOutcome: null },
    })
    modelAnswers([])
    await proposeCleanup(session, 'p1', 'de')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { documents: Array<Record<string, unknown>> }
    expect(body.documents.map((doc) => doc.filename)).toEqual([
      'Einreichplan_v1.pdf',
      'Einreichplan_v2.pdf',
      '~$Baubeschreibung.docx',
      'Baubeschreibung.docx',
    ])
  })

  it("merges the model's reasons with the rules, and marks the proposal as the model's", async () => {
    modelAnswers([
      { id: UUID(1), category: 'superseded', reason: 'Ältere Fassung von Einreichplan_v2.' },
      // An id the closer may not write, should the model name one: dropped.
      { id: UUID(3), category: 'working_copy', reason: 'Kopie.' },
    ])
    const proposal = await proposeCleanup(session, 'p1', 'de')

    expect(proposal.aiUsed).toBe(true)
    expect(proposal.considered).toBe(4)
    expect(proposal.items.map((item) => [item.filename, item.rule, item.aiReason])).toEqual([
      ['~$Baubeschreibung.docx', 'lock-file', null],
      ['Einreichplan_v1.pdf', 'older-version', 'Ältere Fassung von Einreichplan_v2.'],
    ])
  })

  it('falls back to the rules when the model call fails, and says why', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const proposal = await proposeCleanup(session, 'p1', 'de')
    expect(proposal).toMatchObject({ aiUsed: false, aiError: 'backend_unreachable' })
    expect(proposal.items.map((item) => item.filename)).toEqual(['~$Baubeschreibung.docx', 'Einreichplan_v1.pdf'])

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidates: [], error: 'llm_not_configured' }), { status: 200 }))
    expect(await proposeCleanup(session, 'p1', 'de')).toMatchObject({ aiUsed: false, aiError: 'llm_not_configured' })
  })
})

describe('confirmCleanup', () => {
  it('puts the chosen documents into the Papierkorb, through a subfolder of each one’s own folder', async () => {
    const result = await confirmCleanup(session, 'p1', {
      documentIds: [UUID(1), UUID(5), UUID(6)],
      proposedIds: [UUID(1), UUID(5)],
      aiUsed: true,
    })

    expect(result).toEqual({ removed: 3, binEntries: 2 })
    expect(mocks.createProjectFolder.mock.calls.map(([input]) => input.parentId)).toEqual([FOLDER.plaene, null])
    expect(mocks.createProjectFolder.mock.calls[0][0].name).toMatch(/^Ausgemistet \d{4}-\d{2}-\d{2}$/)
    expect(mocks.moveDocumentToFolder.mock.calls.map(([input]) => [input.documentId, input.folderId])).toEqual([
      [UUID(1), `bin-holder-${FOLDER.plaene}`],
      [UUID(5), 'bin-holder-root'],
      [UUID(6), 'bin-holder-root'],
    ])
    expect(mocks.moveFolderToBin.mock.calls.map(([, input]) => input.folderId)).toEqual([
      `bin-holder-${FOLDER.plaene}`,
      'bin-holder-root',
    ])
    // Each subfolder is binned only holding exactly what was moved into it.
    expect(mocks.moveFolderToBin.mock.calls.map(([, , , options]) => options?.onlyDocuments)).toEqual([
      [UUID(1)],
      [UUID(5), UUID(6)],
    ])
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.cleanup.confirmed',
        metadata: expect.objectContaining({ removed: 3, proposed: 2, removedUnproposed: 1, keptProposed: 0, aiUsed: true }),
      })
    )
  })

  it('removes nothing when one chosen document is not the closer’s to remove', async () => {
    await expect(
      confirmCleanup(session, 'p1', { documentIds: [UUID(1), UUID(3)], proposedIds: [], aiUsed: false })
    ).rejects.toMatchObject({ status: 400, details: { reason: 'not-writable', documentIds: [UUID(3)] } })
    expect(mocks.createProjectFolder).not.toHaveBeenCalled()
    expect(mocks.moveDocumentToFolder).not.toHaveBeenCalled()
    expect(mocks.moveFolderToBin).not.toHaveBeenCalled()
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled()
  })

  it('undoes everything when the second folder cannot go to the bin: nothing removed, nothing left behind', async () => {
    mocks.moveFolderToBin.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('index'), { status: 502 }))

    await expect(
      confirmCleanup(session, 'p1', { documentIds: [UUID(1), UUID(5), UUID(6)], proposedIds: [], aiUsed: true })
    ).rejects.toMatchObject({ status: 502 })

    // The first subfolder, already binned, is restored; every document goes back where it was; both subfolders go.
    expect(mocks.restoreFolderFromBin.mock.calls.map(([, input]) => input.folderId)).toEqual([`bin-holder-${FOLDER.plaene}`])
    expect(mocks.moveDocumentToFolder.mock.calls.slice(3).map(([input]) => [input.documentId, input.folderId])).toEqual([
      [UUID(6), null],
      [UUID(5), null],
      [UUID(1), FOLDER.plaene],
    ])
    expect(mocks.deleteEmptyCreatedFolder.mock.calls.map(([, , folderId]) => folderId)).toEqual([
      'bin-holder-root',
      `bin-holder-${FOLDER.plaene}`,
    ])
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled()
  })

  it('undoes the moves when a document cannot be moved, and bins nothing', async () => {
    mocks.moveDocumentToFolder
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'Folder not found in this project.' })

    await expect(
      confirmCleanup(session, 'p1', { documentIds: [UUID(1), UUID(5), UUID(6)], proposedIds: [], aiUsed: true })
    ).rejects.toMatchObject({ status: 400 })

    expect(mocks.moveFolderToBin).not.toHaveBeenCalled()
    expect(mocks.moveDocumentToFolder.mock.calls.slice(2).map(([input]) => [input.documentId, input.folderId])).toEqual([
      [UUID(1), FOLDER.plaene],
    ])
    expect(mocks.deleteEmptyCreatedFolder.mock.calls.map(([, , folderId]) => folderId)).toEqual([
      'bin-holder-root',
      `bin-holder-${FOLDER.plaene}`,
    ])
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled()
  })

  it('says where files may be left when the undo itself stops short, and keeps the original status', async () => {
    mocks.moveFolderToBin.mockResolvedValueOnce({}).mockRejectedValueOnce(new UpstreamError('index did not confirm'))
    // The Pläne subfolder cannot be removed: something is still in it.
    mocks.deleteEmptyCreatedFolder.mockImplementation(async (_org: string, _project: string, id: string) => id !== `bin-holder-${FOLDER.plaene}`)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const failure = await confirmCleanup(session, 'p1', { documentIds: [UUID(1), UUID(5)], proposedIds: [], aiUsed: true }).catch(
      (error: unknown) => error
    )
    expect(failure).toMatchObject({
      status: 502,
      details: { reason: 'cleanup-partially-undone', folders: [expect.stringMatching(/^Ausgemistet \d{4}-\d{2}-\d{2}$/)] },
    })
    expect((failure as Error).message).toMatch(/could not be fully undone.*Papierkorb/)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`remove bin-holder-${FOLDER.plaene} failed`), expect.anything())
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('names the subfolder with a counter when one of that name exists', async () => {
    mocks.createProjectFolder
      .mockResolvedValueOnce({ ok: false, error: 'A folder with this name already exists here.' })
      .mockResolvedValueOnce({ ok: true, folder: { id: 'holder-2' } })
    await confirmCleanup(session, 'p1', { documentIds: [UUID(1)], proposedIds: [UUID(1)], aiUsed: true })
    expect(mocks.createProjectFolder.mock.calls[1][0].name).toMatch(/ \(2\)$/)
  })
})
