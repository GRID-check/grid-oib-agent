/**
 * @vitest-environment node
 *
 * The suggest job (`./suggest-job`): who is asked about, that the budget is
 * asked first, that the model reads no text, that the answer lands on the
 * parts that still wait, and that a failure leaves the mail without a
 * suggestion rather than failing anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend.test' }))

const state = vi.hoisted(() => ({
  mail: null as InboundMailRow | null,
  parts: [] as InboundMailPartRow[],
  stored: new Map<string, unknown>(),
}))

vi.mock('./repository', () => ({
  findMailForReceive: vi.fn(async () => state.mail),
  findMailParts: vi.fn(async () => state.parts),
  storePartSuggestions: vi.fn(async (_mailId: string, suggestions: Map<string, unknown>) => {
    for (const [partId, suggestion] of suggestions) state.stored.set(partId, suggestion)
    return suggestions.size
  }),
}))
// The text and the bytes: the job must never reach them. Each throws if it does.
vi.mock('./staging', () => ({
  readStagedObject: vi.fn(() => {
    throw new Error('the suggest job read a staged object')
  }),
}))
vi.mock('./read-client', () => ({
  readMail: vi.fn(() => {
    throw new Error('the suggest job read the mail')
  }),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: PROJECT_ID, status: 'active' })),
  listProjectsInOrg: vi.fn(async () => []),
}))
vi.mock('@/lib/budgets/unasked-spend', () => ({ unaskedSpendAllowed: vi.fn(async () => true) }))
vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectFolderTree: vi.fn(async () => [
    { id: FOLDER_ID, parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: RESTRICTED_ID, parentId: null, accessMode: 'custom', everyoneReads: false },
  ]),
}))
vi.mock('@/lib/filing/repository', () => ({
  listProjectsFolders: vi.fn(async (_org: string, projectIds: string[]) =>
    projectIds.includes(PROJECT_ID)
      ? [
          { id: FOLDER_ID, projectId: PROJECT_ID, parentId: null, path: 'Tragwerk', description: 'Statik', accessMode: 'inherit' },
          { id: RESTRICTED_ID, projectId: PROJECT_ID, parentId: null, path: 'Personal', description: null, accessMode: 'custom' },
        ]
      : [],
  ),
  listFiledDocuments: vi.fn(async () => []),
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn(async <T,>(rows: T[]) => rows) }))
vi.mock('@/lib/upload-screening/service', () => ({ gatePolicy: vi.fn(async () => ({ enabled: false })) }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))

import { unaskedSpendAllowed } from '@/lib/budgets/unasked-spend'
import { findProjectInOrg } from '@/lib/projects/repository'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { FILE_PART_ID, FOLDER_ID, MAIL_ID, PROJECT_ID, TEXT_PART_ID, filePart, heldMail, textPart } from './__fixtures__/review'
import { inboundMailJobId } from './receive-job'
import { storePartSuggestions } from './repository'
import { suggestForMail } from './suggest-job'

const RESTRICTED_ID = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d'
const ORG = 'org_1'
const TRACE = 'abcdef0123456789abcdef0123456789'
const PAYLOAD = { mailId: MAIL_ID, projectId: PROJECT_ID }

let fetchMock: ReturnType<typeof vi.spyOn>

function answer(moves: object[], extra: object = {}) {
  fetchMock.mockResolvedValue(Response.json({ moves, model: 'm', error: null, trace_id: TRACE, ...extra }))
}

/** The body the job sent to `/v1/filing-fit`. */
const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  state.mail = heldMail({ threadMatch: [] })
  state.parts = [textPart(), filePart()]
  state.stored = new Map()
  fetchMock = vi.spyOn(globalThis, 'fetch')
  answer([
    { id: FILE_PART_ID, folder: 'Tragwerk', type: 'Gutachten', reason: 'Die Statik.' },
    { id: TEXT_PART_ID, folder: 'Behörde und Bescheide', reason: 'Schriftverkehr mit dem Statiker.' },
  ])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the job id', () => {
  it('is derived from the mail with uuid5, never the mail id, which is the receive job’s', () => {
    const id = inboundMailJobId('suggest', MAIL_ID)
    expect(id).not.toBe(MAIL_ID)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(inboundMailJobId('suggest', MAIL_ID)).toBe(id)
    expect(inboundMailJobId('follow', MAIL_ID)).not.toBe(id)
  })
})

describe('who is asked about', () => {
  it.each([
    ['an unconfirmed sender', { senderTrust: 'external_unverified' as const }, 'external_unverified'],
    ['automatic mail', { automatic: true }, 'automatic'],
    ['a mail already decided', { status: 'settled' as const }, 'not_waiting'],
  ])('asks nothing about %s', async (_case, overrides, reason) => {
    state.mail = heldMail({ threadMatch: [], ...overrides })
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'skipped', reason })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(unaskedSpendAllowed).not.toHaveBeenCalled()
  })

  it('asks nothing about another organization’s or another project’s mail', async () => {
    expect(await suggestForMail('org_2', PAYLOAD)).toEqual({ status: 'skipped', reason: 'not_waiting' })
    expect(await suggestForMail(ORG, { ...PAYLOAD, projectId: RESTRICTED_ID })).toEqual({ status: 'skipped', reason: 'not_waiting' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks nothing when switched off for the deployment, or in a closed project', async () => {
    vi.stubEnv('GRID_FILING_SUGGESTIONS', 'off')
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'skipped', reason: 'switched_off' })
    vi.unstubAllEnvs()
    vi.mocked(findProjectInOrg).mockResolvedValueOnce({ id: PROJECT_ID, status: 'closed' } as never)
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'skipped', reason: 'project_closed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks nothing, and spends nothing, when nothing can be placed', async () => {
    state.mail = heldMail()
    state.parts = [textPart(), filePart({ nameStopTerms: ['Honorar'], riskFlags: ['name_stop'] })]
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'skipped', reason: 'nothing_to_place' })
    expect(unaskedSpendAllowed).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the budget', () => {
  it('is asked before the call, for the organization and the project, as no person', async () => {
    vi.mocked(unaskedSpendAllowed).mockResolvedValueOnce(false)
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'skipped', reason: 'budget' })
    expect(unaskedSpendAllowed).toHaveBeenCalledWith({ organizationId: ORG, userId: null }, PROJECT_ID)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storePartSuggestions).not.toHaveBeenCalled()
  })
})

describe('what the model reads', () => {
  it('reads names, the subject, the sender’s domain and the folders every member reads; never the text', async () => {
    await suggestForMail(ORG, PAYLOAD)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = sentBody()
    expect(body).toMatchObject({
      basis: 'mail',
      documents: [{ id: FILE_PART_ID, file: 'S-101_C.pdf' }],
      mail: { subject: 'AW: Statik Einreichung', sender_domain: 'statik-weber.at', text_id: TEXT_PART_ID },
    })
    expect((body.folders as Array<{ path: string }>).map((folder) => folder.path)).toEqual(['Tragwerk'])
    const sent = JSON.stringify(body)
    expect(sent).not.toContain('Personal')
    expect(sent).not.toContain('read.json')
    expect(sent).not.toContain('p.weber@')
    expect(sent).not.toContain('DI Petra Weber')
  })

  it('reads the subject masked, as every reader sees it', async () => {
    const { gatePolicy } = await import('@/lib/upload-screening/service')
    const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
    vi.mocked(gatePolicy).mockResolvedValueOnce({ ...SUGGESTED_SCREENING_POLICY, enabled: true, contentTerms: ['Einreichung'] })
    await suggestForMail(ORG, PAYLOAD)
    expect(JSON.stringify(sentBody().mail)).not.toContain('Einreichung')
  })
})

describe('the office’s conventions', () => {
  it('are folders several of its projects keep, never a folder only one other project has', async () => {
    const { listProjectsInOrg } = await import('@/lib/projects/repository')
    const { listProjectsFolders } = await import('@/lib/filing/repository')
    vi.mocked(listProjectsInOrg).mockResolvedValueOnce([{ id: 'p-a' }, { id: 'p-b' }, { id: PROJECT_ID }] as never)
    const kept = (id: string, projectId: string, path: string) => ({ id, projectId, parentId: null, path, description: null, accessMode: 'inherit' as const })
    const folders = async (_org: string, projectIds: readonly string[]) =>
      projectIds.includes(PROJECT_ID)
        ? [kept(FOLDER_ID, PROJECT_ID, 'Tragwerk')]
        : [kept('f1', 'p-a', 'Korrespondenz'), kept('f2', 'p-b', 'Korrespondenz'), kept('f3', 'p-b', 'Scheidung Huber')]
    // Once for the project's own folders, once for the other projects'.
    vi.mocked(listProjectsFolders).mockImplementationOnce(folders).mockImplementationOnce(folders)
    await suggestForMail(ORG, PAYLOAD)
    expect((sentBody().conventions as Array<{ path: string }>).map((convention) => convention.path)).toEqual(['Korrespondenz'])
  })
})

describe('the answer', () => {
  it('is stored on the parts with the generation’s trace, and the project is told', async () => {
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'suggested', parts: 2, traceId: TRACE })
    expect(vi.mocked(storePartSuggestions).mock.calls[0][2]).toBe(TRACE)
    expect(Object.fromEntries(state.stored)).toEqual({
      [FILE_PART_ID]: { folderId: FOLDER_ID, folderPath: 'Tragwerk', newFolder: false, documentType: 'Gutachten', reason: 'Die Statik.' },
      // The office has no other project: the Austrian default is its convention, created when filed.
      [TEXT_PART_ID]: {
        folderId: null,
        folderPath: 'Behörde und Bescheide',
        newFolder: true,
        documentType: null,
        reason: 'Schriftverkehr mit dem Statiker.',
      },
    })
    expect(publishProjectChanged).toHaveBeenCalledWith(ORG, PROJECT_ID)
  })

  it('fails open: a backend that is down leaves the mail without a suggestion and throws nothing', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }))
    expect(await suggestForMail(ORG, PAYLOAD)).toEqual({ status: 'failed', reason: 'backend_503' })
    expect(storePartSuggestions).not.toHaveBeenCalled()
    expect(publishProjectChanged).not.toHaveBeenCalled()
  })
})
