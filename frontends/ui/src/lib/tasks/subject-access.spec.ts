/**
 * @vitest-environment node
 *
 * The rule behind `subject-access.ts` (ADR-0092), with the folder tree, the
 * document lookup and the clearance faked. The SQL and the wiring into the
 * task list, the run view and the thread are proved against Postgres in
 * `subject-access.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ findSubjectDocumentPlaces: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/authz/folder-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/folder-access')>()
  return { ...actual, clearanceOf: vi.fn() }
})

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { clearanceOf } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import type { TaskPlan } from '@/lib/db/schema'
import { findSubjectDocumentPlaces } from './repository'
import { requireMaySeeSubject, withoutUnreadableSubjects } from './subject-access'

const PROJECT = 'project-1'
const OPEN = 'folder-open'
const FEES = 'folder-fees'
const session = { userId: 'user_1', organizationId: 'org_1' } as AuthorizedSession

const plan = (documentId?: string): TaskPlan => ({
  prompt: 'Überarbeite …',
  skill: {} as TaskPlan['skill'],
  dataSources: null,
  ...(documentId ? { subject: { documentId, versionId: 'v-1', comment: 'Honorar korrigieren' } } : {}),
})
const run = (id: string, documentId?: string) => ({ id, plan: plan(documentId) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listProjectFolderTree).mockResolvedValue([
    { id: OPEN, parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: FEES, parentId: null, accessMode: 'custom', everyoneReads: false },
  ])
  vi.mocked(clearanceOf).mockResolvedValue({ levels: {}, seesEverything: false })
  vi.mocked(findSubjectDocumentPlaces).mockResolvedValue(
    new Map([
      ['doc-open', { projectId: PROJECT, folderId: OPEN }],
      ['doc-fees', { projectId: PROJECT, folderId: FEES }],
      ['doc-root', { projectId: PROJECT, folderId: null }],
      ['doc-elsewhere', { projectId: 'project-2', folderId: null }],
    ])
  )
})

describe('withoutUnreadableSubjects', () => {
  it('asks nothing for tasks that revise no document', async () => {
    const rows = [run('a'), run('b')]
    expect(await withoutUnreadableSubjects(session, PROJECT, rows)).toEqual(rows)
    expect(findSubjectDocumentPlaces).not.toHaveBeenCalled()
    expect(clearanceOf).not.toHaveBeenCalled()
  })

  it('leaves out a revision of a document in a folder the reader may not read now, and keeps the order', async () => {
    const rows = [run('plain'), run('open', 'doc-open'), run('fees', 'doc-fees'), run('root', 'doc-root')]
    const kept = await withoutUnreadableSubjects(session, PROJECT, rows)
    expect(kept.map((row) => row.id)).toEqual(['plain', 'open', 'root'])
  })

  it('keeps it for a reader whose folder role reads the folder', async () => {
    vi.mocked(clearanceOf).mockResolvedValue({ levels: { [FEES]: 'read' }, seesEverything: false })
    const kept = await withoutUnreadableSubjects(session, PROJECT, [run('fees', 'doc-fees')])
    expect(kept.map((row) => row.id)).toEqual(['fees'])
  })

  it('withholds a document of another project and keeps one that is gone', async () => {
    const kept = await withoutUnreadableSubjects(session, PROJECT, [run('elsewhere', 'doc-elsewhere'), run('gone', 'doc-gone')])
    expect(kept.map((row) => row.id)).toEqual(['gone'])
  })
})

describe('requireMaySeeSubject', () => {
  it('answers 404, as for an unknown task, when the reader may not read the document’s folder', async () => {
    await expect(requireMaySeeSubject(session, PROJECT, run('fees', 'doc-fees'), 'Unknown run')).rejects.toEqual(
      new NotFoundError('Unknown run')
    )
  })

  it('lets a readable one through', async () => {
    await expect(requireMaySeeSubject(session, PROJECT, run('open', 'doc-open'))).resolves.toBeUndefined()
  })
})
