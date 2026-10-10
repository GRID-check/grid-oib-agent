/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const insertAccessLogEntry = vi.fn()
const listAccessLog = vi.fn()
vi.mock('./repository', () => ({
  insertAccessLogEntry: (...args: unknown[]) => insertAccessLogEntry(...args),
  listAccessLog: (...args: unknown[]) => listAccessLog(...args),
}))

const loadCustomFolderTree = vi.fn()
const clearanceOf = vi.fn()
const readableFoldersOfRestrictedProjects = vi.fn()
const seesEveryFolder = vi.fn()
vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access-rule')>()),
  loadCustomFolderTree: (...args: unknown[]) => loadCustomFolderTree(...args),
  clearanceOf: (...args: unknown[]) => clearanceOf(...args),
  readableFoldersOfRestrictedProjects: (...args: unknown[]) => readableFoldersOfRestrictedProjects(...args),
  seesEveryFolder: (...args: unknown[]) => seesEveryFolder(...args),
}))

const recordAuditEvent = vi.fn()
const recordAuditEventOrThrow = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
  recordAuditEventOrThrow: (...args: unknown[]) => recordAuditEventOrThrow(...args),
}))

const getOrgSettings = vi.fn()
const writeDedicatedOrgSetting = vi.fn()
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: (...args: unknown[]) => getOrgSettings(...args),
  writeDedicatedOrgSetting: (...args: unknown[]) => writeDedicatedOrgSetting(...args),
}))

const resolvePeople = vi.fn()
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: (...args: unknown[]) => resolvePeople(...args) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import {
  decodeCursor,
  encodeCursor,
  listDownloadLog,
  recordDocumentAccess,
  setDownloadLogRetentionDays,
  type LoggedDocument,
} from './service'

const FOLDER = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const OPEN_FOLDER = '33333333-3333-4333-8333-333333333333'
const PROJECT = '44444444-4444-4444-8444-444444444444'
const VERSION = '55555555-5555-4555-8555-555555555555'
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const session = (permissions: string[] = []): AuthorizedSession => ({
  userId: 'user-1',
  email: 'a@example.com',
  name: 'A',
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions,
  featureFlags: null,
})

const document = (overrides: Partial<LoggedDocument> = {}): LoggedDocument => ({
  id: 'doc-1',
  scope: 'project',
  projectId: PROJECT,
  folderId: FOLDER,
  filename: 'Werkvertrag.pdf',
  displayName: null,
  publishedVersionId: null,
  ...overrides,
})

/** Folders: Verträge has its own list, Anhänge below it inherits, Allgemein inherits. */
const tree = () => [
  { id: FOLDER, parentId: null, accessMode: 'custom', grants: [{ role: 'org-gf', level: 'write' }] },
  { id: CHILD, parentId: FOLDER, accessMode: 'inherit', grants: [] },
  { id: OPEN_FOLDER, parentId: null, accessMode: 'inherit', grants: [] },
]

beforeEach(() => {
  vi.clearAllMocks()
  insertAccessLogEntry.mockResolvedValue(undefined)
  loadCustomFolderTree.mockResolvedValue(tree())
  recordAuditEventOrThrow.mockResolvedValue(undefined)
  recordAuditEvent.mockResolvedValue(undefined)
  getOrgSettings.mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: {} })
  resolvePeople.mockResolvedValue(new Map())
  // An organization admin: clears every folder.
  clearanceOf.mockResolvedValue({ roles: ['admin'], seesEverything: true })
  seesEveryFolder.mockResolvedValue(true)
})

describe('recordDocumentAccess: what is recorded', () => {
  it('records a download wherever the document is filed', async () => {
    await recordDocumentAccess(session(), document({ folderId: OPEN_FOLDER }), 'download')

    expect(insertAccessLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        kind: 'download',
        scope: 'project',
        projectId: PROJECT,
        documentId: 'doc-1',
        documentName: 'Werkvertrag.pdf',
        folderId: OPEN_FOLDER,
        ownList: false,
      })
    )
  })

  it('records an open under a folder with its own list', async () => {
    await recordDocumentAccess(session(), document({ folderId: FOLDER }), 'preview')

    expect(insertAccessLogEntry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'preview', ownList: true }))
  })

  it('records an open in a plain subfolder of a folder with its own list', async () => {
    await recordDocumentAccess(session(), document({ folderId: CHILD }), 'text')

    expect(insertAccessLogEntry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', ownList: true, folderId: CHILD }))
  })

  it.each(['preview', 'pdf', 'text', 'version', 'model'] as const)('does not record a %s of an ordinary folder', async (kind) => {
    await recordDocumentAccess(session(), document({ folderId: OPEN_FOLDER }), kind)

    expect(insertAccessLogEntry).not.toHaveBeenCalled()
  })

  it('does not record an open of the project root, a project without own lists, the Archiv or a chat attachment', async () => {
    await recordDocumentAccess(session(), document({ folderId: null }), 'preview')
    loadCustomFolderTree.mockResolvedValue(null)
    await recordDocumentAccess(session(), document({ folderId: OPEN_FOLDER }), 'preview')
    await recordDocumentAccess(session(), document({ scope: 'archiv', projectId: null, folderId: null }), 'pdf')
    await recordDocumentAccess(session(), document({ scope: 'session', projectId: null, folderId: null }), 'pdf')

    expect(insertAccessLogEntry).not.toHaveBeenCalled()
  })

  it('names no project or folder for a shelf that has none, even when the row carries a stale one', async () => {
    await recordDocumentAccess(session(), document({ scope: 'archiv', projectId: PROJECT, folderId: FOLDER }), 'download')

    expect(insertAccessLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'archiv', projectId: null, folderId: null, ownList: false })
    )
  })

  it('records the version the route names, else the published one, and the name the document is shown under', async () => {
    await recordDocumentAccess(
      session(),
      document({ publishedVersionId: VERSION, displayName: 'Vertrag (final)' }),
      'version',
      { versionId: ID_A }
    )
    await recordDocumentAccess(session(), document({ publishedVersionId: VERSION }), 'download')

    expect(insertAccessLogEntry.mock.calls[0][0]).toMatchObject({ versionId: ID_A, documentName: 'Vertrag (final)' })
    expect(insertAccessLogEntry.mock.calls[1][0]).toMatchObject({ versionId: VERSION })
  })

  it('cuts a very long name to what the table accepts', async () => {
    await recordDocumentAccess(session(), document({ filename: 'x'.repeat(900) }), 'download')

    expect(insertAccessLogEntry.mock.calls[0][0].documentName).toHaveLength(500)
  })
})

describe('recordDocumentAccess: when the log fails', () => {
  it('lets a download from an ordinary folder through, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    insertAccessLogEntry.mockRejectedValue(new Error('connection lost'))

    await expect(recordDocumentAccess(session(), document({ folderId: OPEN_FOLDER }), 'download')).resolves.toBeUndefined()

    expect(warn.mock.calls[0][0]).toContain('could not record a download of document doc-1: connection lost')
  })

  it('refuses the hand-over from a folder with its own list (503), naming no folder', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    insertAccessLogEntry.mockRejectedValue(new Error('connection lost'))

    const refusal = recordDocumentAccess(session(), document({ folderId: FOLDER }), 'download')

    await expect(refusal).rejects.toMatchObject({ status: 503, details: { reason: 'download-log-unavailable' } })
    await expect(refusal).rejects.not.toThrow(/Verträge|connection/)
  })

  it('treats a folder it could not read as possibly under an own list, and refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    loadCustomFolderTree.mockRejectedValue(new Error('timeout'))

    await expect(recordDocumentAccess(session(), document({ folderId: OPEN_FOLDER }), 'download')).rejects.toMatchObject({
      status: 503,
    })
    expect(insertAccessLogEntry).not.toHaveBeenCalled()
  })
})

describe('the admin view', () => {
  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    occurredAt: new Date(`2026-10-0${n}T10:00:00.123Z`),
    cursor: { occurredAt: `2026-10-0${n}T10:00:00.123456Z`, id: `00000000-0000-4000-8000-00000000000${n}` },
    userId: n === 1 ? 'user-gone' : 'user-1',
    kind: n === 2 ? 'preview' : 'download',
    scope: 'project',
    projectId: PROJECT,
    projectName: 'Neubau',
    documentId: 'doc-1',
    documentName: 'Werkvertrag.pdf',
    versionId: null,
    folderId: FOLDER,
    folderPath: 'Verträge',
    ownList: true,
  })
  const admin = () => session(['org:downloads:view'])
  const request = () => new Request('http://x/api/organization/download-log')

  it('refuses anyone without the permission, before anything is read or audited', async () => {
    await expect(listDownloadLog(session(), {}, request())).rejects.toMatchObject({ status: 403 })

    expect(recordAuditEventOrThrow).not.toHaveBeenCalled()
    expect(listAccessLog).not.toHaveBeenCalled()
  })

  it('records the read in the audit trail BEFORE it reads, with the filters and none of the findings', async () => {
    const order: string[] = []
    recordAuditEventOrThrow.mockImplementation(async () => void order.push('audit'))
    listAccessLog.mockImplementation(async () => {
      order.push('read')
      return [row(3)]
    })

    await listDownloadLog(admin(), { userId: 'user-9', document: ID_A, kind: 'download', from: new Date('2026-09-01T00:00:00Z') }, request())

    expect(order).toEqual(['audit', 'read'])
    expect(recordAuditEventOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        actor: { userId: 'user-1', email: 'a@example.com' },
        action: 'download_log.viewed',
        targetType: 'organization',
        metadata: expect.objectContaining({
          userId: 'user-9',
          documentId: ID_A,
          kind: 'download',
          from: '2026-09-01T00:00:00.000Z',
          continued: false,
        }),
      })
    )
  })

  it('serves nothing when the audit event cannot be written', async () => {
    recordAuditEventOrThrow.mockRejectedValue(new Error('WorkOS rejected the event'))

    await expect(listDownloadLog(admin(), {}, request())).rejects.toThrow('WorkOS rejected')

    expect(listAccessLog).not.toHaveBeenCalled()
  })

  it('treats a document filter that is an id as an id and any other text as part of a name', async () => {
    listAccessLog.mockResolvedValue([])
    await listDownloadLog(admin(), { document: ID_A.toUpperCase() }, request())
    await listDownloadLog(admin(), { document: ' Werkvertrag ' }, request())

    expect(listAccessLog.mock.calls[0][0]).toMatchObject({ documentId: ID_A })
    expect(listAccessLog.mock.calls[1][0]).toMatchObject({ documentName: 'Werkvertrag' })
    expect(listAccessLog.mock.calls[1][0].documentId).toBeUndefined()
  })

  it('asks for one row more than it shows, and hands back a cursor only when there is one', async () => {
    listAccessLog.mockResolvedValue([row(3), row(2), row(1)])

    const page = await listDownloadLog(admin(), { limit: 2 }, request())

    expect(listAccessLog.mock.calls[0][2]).toBe(3)
    expect(page.entries).toHaveLength(2)
    expect(decodeCursor(page.nextCursor as string)).toEqual(row(2).cursor)

    listAccessLog.mockResolvedValue([row(3)])
    expect((await listDownloadLog(admin(), { limit: 2 }, request())).nextCursor).toBeNull()
  })

  it('bounds the page, whatever was asked', async () => {
    listAccessLog.mockResolvedValue([])
    await listDownloadLog(admin(), { limit: 100_000 }, request())
    await listDownloadLog(admin(), {}, request())

    expect(listAccessLog.mock.calls[0][2]).toBe(101)
    expect(listAccessLog.mock.calls[1][2]).toBe(51)
  })

  it('marks every page after the first in the audit event', async () => {
    listAccessLog.mockResolvedValue([])

    await listDownloadLog(admin(), { cursor: encodeCursor(row(2).cursor) }, request())

    expect(recordAuditEventOrThrow.mock.calls[0][0].metadata.continued).toBe(true)
  })

  it('names people from WorkOS, and leaves someone who is gone as an id only', async () => {
    listAccessLog.mockResolvedValue([row(3), row(1)])
    resolvePeople.mockResolvedValue(new Map([['user-1', { userId: 'user-1', name: 'Anna Beispiel', email: 'anna@example.com' }]]))

    const page = await listDownloadLog(admin(), {}, request())

    expect(page.entries.map((entry) => [entry.userId, entry.person])).toEqual([
      ['user-1', { name: 'Anna Beispiel', email: 'anna@example.com' }],
      ['user-gone', null],
    ])
    expect(resolvePeople).toHaveBeenCalledWith('org-1', ['user-1', 'user-gone'])
  })

  it('calls a download a download and everything else an open, and reports the retention in force', async () => {
    listAccessLog.mockResolvedValue([row(3), row(2)])
    getOrgSettings.mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: { downloadLogRetentionDays: 90 } })

    const page = await listDownloadLog(admin(), {}, request())

    expect(page.entries.map((entry) => entry.access)).toEqual(['download', 'open'])
    expect(page.retentionDays).toBe(90)
  })

  describe('a viewer the permission does not clear for every folder (a custom role given org:downloads:view)', () => {
    const viewer = () => session(['org:downloads:view'])
    const openRow = () => ({ ...row(3), folderId: OPEN_FOLDER, folderPath: 'Allgemein', documentName: 'Plan.pdf', ownList: false })
    const restrictedRow = () => ({ ...row(2), folderId: CHILD, folderPath: 'Verträge/Anhänge', documentName: 'Gehaltsliste.xlsx' })
    beforeEach(() => {
      clearanceOf.mockResolvedValue({ roles: ['org-revision'], seesEverything: false })
      seesEveryFolder.mockResolvedValue(false)
    })

    it('names neither the document nor the folder of a row logged in a folder they may not read', async () => {
      listAccessLog.mockResolvedValue([openRow(), restrictedRow()])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(page.entries.map((entry) => [entry.documentName, entry.folderPath, entry.nameWithheld])).toEqual([
        ['Plan.pdf', 'Allgemein', false],
        [null, null, true],
      ])
      // Who, when, what and which id stay: the log still answers for the hand-over.
      expect(page.entries[1]).toMatchObject({ documentId: 'doc-1', kind: 'preview', folderId: CHILD, ownList: true })
    })

    it('names it once a role on the list clears them, and reads the folder tree once per project', async () => {
      clearanceOf.mockResolvedValue({ roles: ['org-gf'], seesEverything: false })
      listAccessLog.mockResolvedValue([openRow(), restrictedRow()])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(page.entries.map((entry) => entry.documentName)).toEqual(['Plan.pdf', 'Gehaltsliste.xlsx'])
      expect(loadCustomFolderTree).toHaveBeenCalledTimes(1)
    })

    it('decides each row by the clearance in its own project: a closed one clears an outsider as a member with no role', async () => {
      const CLOSED = '77777777-7777-4777-8777-777777777777'
      // The Geschäftsführung role, which Verträge grants. In the closed project
      // the viewer reads only because it is closed, so it clears no list there (ADR-0090).
      clearanceOf.mockImplementation(async (_session: AuthorizedSession, projectId: string) =>
        projectId === CLOSED ? { roles: [], seesEverything: false } : { roles: ['org-gf'], seesEverything: false }
      )
      listAccessLog.mockResolvedValue([restrictedRow(), { ...restrictedRow(), projectId: CLOSED, projectName: 'Altbau' }])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(page.entries.map((entry) => [entry.projectName, entry.documentName, entry.nameWithheld])).toEqual([
        ['Neubau', 'Gehaltsliste.xlsx', false],
        ['Altbau', null, true],
      ])
      expect(clearanceOf.mock.calls.map(([, projectId]) => projectId)).toEqual([PROJECT, CLOSED])
    })

    it('withholds the name of a folder the tree no longer holds', async () => {
      listAccessLog.mockResolvedValue([{ ...restrictedRow(), folderId: '66666666-6666-4666-8666-666666666666' }])

      expect((await listDownloadLog(viewer(), {}, request())).entries[0]).toMatchObject({ documentName: null, nameWithheld: true })
    })

    it('lets a name filter match only names they may read, so typing a name does not probe a restricted folder', async () => {
      readableFoldersOfRestrictedProjects.mockResolvedValue([OPEN_FOLDER])
      listAccessLog.mockResolvedValue([openRow()])

      const page = await listDownloadLog(viewer(), { document: 'a' }, request())

      expect(page.entries.map((entry) => entry.documentName)).toEqual(['Plan.pdf'])
      expect(readableFoldersOfRestrictedProjects).toHaveBeenCalledWith(viewer())
      expect(listAccessLog.mock.calls[0][0]).toMatchObject({
        documentName: 'a',
        readable: { folderIds: [OPEN_FOLDER], recordedListReadable: false },
      })
    })

    it('narrows a name filter before the page limit, so the rows it leaves out shape neither the page nor its cursor', async () => {
      // The newest hit is in a folder they may not read. The database, as the
      // double plays it, applies `readable` before the limit, as it does `documentName`.
      const hits = [
        restrictedRow(),
        { ...openRow(), ...row(2), folderId: OPEN_FOLDER, folderPath: 'Allgemein', documentName: 'Plan.pdf', ownList: false },
        { ...openRow(), ...row(1), folderId: OPEN_FOLDER, folderPath: 'Allgemein', documentName: 'Plan alt.pdf', ownList: false },
      ]
      listAccessLog.mockImplementation(async (filter: { readable?: { folderIds: string[] } }, _cursor: unknown, limit: number) =>
        hits.filter((hit) => !filter.readable || filter.readable.folderIds.includes(hit.folderId)).slice(0, limit)
      )
      readableFoldersOfRestrictedProjects.mockResolvedValue([OPEN_FOLDER])

      const page = await listDownloadLog(viewer(), { document: 'Plan', limit: 1 }, request())

      // A full page and a cursor that points past a readable row: the
      // restricted hit took no slot, and the cursor names no row of it.
      expect(page.entries.map((entry) => [entry.documentName, entry.nameWithheld])).toEqual([['Plan.pdf', false]])
      expect(decodeCursor(page.nextCursor as string)).toEqual(row(2).cursor)
    })

    it('opens a name filter to the rows of a purged project logged under their own list only for someone who sees every folder', async () => {
      readableFoldersOfRestrictedProjects.mockResolvedValue([])
      listAccessLog.mockResolvedValue([])
      await listDownloadLog(viewer(), { document: 'Gehalt' }, request())
      seesEveryFolder.mockResolvedValue(true)
      await listDownloadLog(viewer(), { document: 'Gehalt' }, request())

      expect(listAccessLog.mock.calls.map(([filter]) => filter.readable.recordedListReadable)).toEqual([false, true])
    })

    it('narrows nothing without a name filter: every row is listed, a restricted one without its name', async () => {
      listAccessLog.mockResolvedValue([openRow(), restrictedRow()])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(listAccessLog.mock.calls[0][0].readable).toBeUndefined()
      expect(readableFoldersOfRestrictedProjects).not.toHaveBeenCalled()
      expect(page.entries.map((entry) => entry.nameWithheld)).toEqual([false, true])
    })

    it('withholds the name of a row whose project is gone, by the list it was logged under', async () => {
      // A purged project leaves no folder rows: no tree, no project name, no path.
      loadCustomFolderTree.mockResolvedValue(null)
      const purged = { ...restrictedRow(), projectName: null, folderPath: null }
      listAccessLog.mockResolvedValue([purged, { ...openRow(), projectName: null, folderPath: null }])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(page.entries.map((entry) => [entry.documentName, entry.nameWithheld])).toEqual([
        [null, true],
        ['Plan.pdf', false],
      ])

      clearanceOf.mockResolvedValue({ roles: ['admin'], seesEverything: true })
      expect((await listDownloadLog(viewer(), {}, request())).entries[0]).toMatchObject({
        documentName: 'Gehaltsliste.xlsx',
        nameWithheld: false,
      })
    })

    it('asks nobody about clearance when no project on the page has a folder with its own list', async () => {
      loadCustomFolderTree.mockResolvedValue(null)
      listAccessLog.mockResolvedValue([restrictedRow()])

      const page = await listDownloadLog(viewer(), {}, request())

      expect(page.entries[0]).toMatchObject({ documentName: 'Gehaltsliste.xlsx', nameWithheld: false })
      expect(clearanceOf).not.toHaveBeenCalled()
    })
  })

  it('names every document to an organization admin', async () => {
    listAccessLog.mockResolvedValue([row(3)])

    const page = await listDownloadLog(admin(), {}, request())

    expect(page.entries[0]).toMatchObject({ documentName: 'Werkvertrag.pdf', folderPath: 'Verträge', nameWithheld: false })
  })

  it('records that a name filter was set, never the text, which may be a restricted document’s name', async () => {
    listAccessLog.mockResolvedValue([])

    await listDownloadLog(admin(), { document: 'Gehaltsliste' }, request())
    await listDownloadLog(admin(), {}, request())

    const [filtered, unfiltered] = recordAuditEventOrThrow.mock.calls.map(([event]) => event.metadata)
    expect(filtered.nameFiltered).toBe(true)
    expect(JSON.stringify(filtered)).not.toContain('Gehaltsliste')
    expect(unfiltered.nameFiltered).toBeUndefined()
  })

  it.each(['not-base64!!', Buffer.from('["2026-10-01","x"]').toString('base64url'), Buffer.from('{}').toString('base64url')])(
    'refuses a damaged cursor (%s) as a bad request',
    async (cursor) => {
      await expect(listDownloadLog(admin(), { cursor }, request())).rejects.toMatchObject({ status: 400 })
      expect(listAccessLog).not.toHaveBeenCalled()
    }
  )
})

describe('the retention setting', () => {
  const manager = () => session(['org:settings:manage'])

  it.each([30, 90, 365])('stores %i days, audited with the value before', async (days) => {
    getOrgSettings.mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: { downloadLogRetentionDays: 60 } })

    await expect(setDownloadLogRetentionDays(manager(), days, new Request('http://x'))).resolves.toEqual({ days, previous: 60 })

    expect(writeDedicatedOrgSetting).toHaveBeenCalledWith('org-1', 'downloadLogRetentionDays', days)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'download_log.retention.updated', metadata: { days, previous: 60 } })
    )
  })

  it.each([29, 366, 730, 0, -5, 90.5, Number.NaN])('refuses %s: never shorter than 30 days, never longer than 12 months', async (days) => {
    await expect(setDownloadLogRetentionDays(manager(), days, new Request('http://x'))).rejects.toMatchObject({ status: 400 })

    expect(writeDedicatedOrgSetting).not.toHaveBeenCalled()
  })

  it('needs org:settings:manage', async () => {
    await expect(setDownloadLogRetentionDays(session(['org:downloads:view']), 90, new Request('http://x'))).rejects.toMatchObject({
      status: 403,
    })
    expect(writeDedicatedOrgSetting).not.toHaveBeenCalled()
  })

  it('reads an unset or malformed stored value as the twelve-month default', async () => {
    for (const settings of [{}, { downloadLogRetentionDays: 999 }, { downloadLogRetentionDays: '90' }, { downloadLogRetentionDays: 10 }]) {
      getOrgSettings.mockResolvedValue({ displayName: null, defaultLocale: 'de', settings })
      listAccessLog.mockResolvedValue([])
      expect((await listDownloadLog(session(['org:downloads:view']), {}, new Request('http://x'))).retentionDays).toBe(365)
    }
  })
})

describe('the scheduler and the app agree on the bounds', () => {
  it('purges at the ceiling and the floor the retention setting accepts', async () => {
    const { DOWNLOAD_LOG_MAX_DAYS, DOWNLOAD_LOG_MIN_DAYS } = await import('../../../scheduler/db.js')
    const { DOWNLOAD_LOG_MAX_RETENTION_DAYS, DOWNLOAD_LOG_MIN_RETENTION_DAYS } = await import('./kinds')

    expect(DOWNLOAD_LOG_MAX_DAYS).toBe(DOWNLOAD_LOG_MAX_RETENTION_DAYS)
    expect(DOWNLOAD_LOG_MIN_DAYS).toBe(DOWNLOAD_LOG_MIN_RETENTION_DAYS)
  })

  it('reads the same settings key', async () => {
    const { readFileSync } = await import('node:fs')
    const { DOWNLOAD_LOG_RETENTION_SETTING } = await import('./kinds')

    expect(readFileSync('scheduler/db.js', 'utf8')).toContain(`settings->>'${DOWNLOAD_LOG_RETENTION_SETTING}'`)
  })
})
