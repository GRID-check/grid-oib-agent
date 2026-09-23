/**
 * @vitest-environment node
 */
/**
 * The plan primitive's rules, each pinned once (ADR-0065): how a plan is
 * born under each start policy, that a touch while the clock runs holds it,
 * that the worker's claim starts exactly the due ones, and that nothing edits
 * a started plan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/tasks/delegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tasks/delegation')>()),
  commissionResearchRun: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_reason: string, run: () => Promise<unknown>) => run()),
}))
vi.mock('./repository', () => ({
  insertPlan: vi.fn(),
  findPlanInProject: vi.fn(),
  findPlanById: vi.fn(),
  updatePlan: vi.fn(),
}))

import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ResearchPlanRow } from '@/lib/db/schema'
import { COMMISSION_PERMISSIONS, commissionResearchRun } from '@/lib/tasks/delegation'
import * as repository from './repository'
import {
  DEFAULT_PLAN_GRACE_SECONDS,
  claimPlanStart,
  editPlan,
  holdPlan,
  proposePlannedRun,
  resolveNamedDocuments,
  startPlan,
} from './service'

const T0 = new Date('2026-09-22T08:00:00.000Z')
const PROJECT = '11111111-1111-4111-8111-111111111111'
const session = { userId: 'user_1', organizationId: 'org_1', email: 'p@grid.test' } as AuthorizedSession

const inventory = [
  { name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' },
  { name: 'Altbestand.pdf', shelf: 'project' },
  { name: 'OIB-RL 2.pdf', title: 'OIB-Richtlinie 2', shelf: 'base' },
]

const row = (overrides: Partial<ResearchPlanRow> = {}): ResearchPlanRow => ({
  id: 'plan-1',
  organizationId: 'org_1',
  projectId: PROJECT,
  conversationId: 's_conv',
  runId: null,
  author: 'agent',
  status: 'proposed',
  question: 'Fluchtwege prüfen',
  title: 'Fluchtwege',
  sections: ['Bestand', 'Befund'],
  genre: 'pruefbericht',
  depth: 'gutachten',
  grundlage: [inventory[0]],
  ausgeschlossen: [],
  nurGrundlage: false,
  dataSources: null,
  unterlagen: inventory,
  startsAt: new Date(T0.getTime() + 45_000),
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdBy: 'user_1',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})

const draft = {
  question: 'Fluchtwege prüfen',
  title: 'Fluchtwege',
  sections: ['Bestand', 'Befund'],
  genre: 'pruefbericht' as const,
  depth: 'gutachten' as const,
  grundlage: ['einreichplan', 'Unbekannt.pdf', 'Altbestand.pdf'],
  nurGrundlage: false,
  ausgeschlossen: ['altbestand.pdf'],
  dataSources: ['knowledge_search'],
  unterlagen: inventory,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: T0 })
  vi.mocked(repository.insertPlan).mockImplementation(async (values) => row(values as Partial<ResearchPlanRow>))
  vi.mocked(repository.updatePlan).mockImplementation(async (_id, _org, patch) => row(patch as Partial<ResearchPlanRow>))
  vi.mocked(repository.findPlanInProject).mockResolvedValue(row())
  vi.mocked(repository.findPlanById).mockResolvedValue(row())
  vi.mocked(commissionResearchRun).mockResolvedValue({
    runId: 'run-1',
    runMessageId: 'msg-1',
    conversationId: 's_conv',
    status: 'running',
  })
})

describe('resolveNamedDocuments', () => {
  it('matches on file name or title, case-folded, drops the unknown and keeps each once', () => {
    expect(resolveNamedDocuments(['einreichplan', 'Einreichplan.pdf', 'nichts.pdf', 'oib-richtlinie 2'], inventory)).toEqual([
      inventory[0],
      inventory[2],
    ])
  })
})

describe('proposePlannedRun', () => {
  it('under auto: a proposed plan with a clock, its documents resolved, and the run commissioned on it', async () => {
    const { plan, run } = await proposePlannedRun(session, {
      projectId: PROJECT,
      conversationId: 's_conv',
      draft,
      author: 'agent',
      start: { policy: 'auto' },
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, [...COMMISSION_PERMISSIONS])
    const inserted = vi.mocked(repository.insertPlan).mock.calls[0][0]
    expect(inserted).toMatchObject({
      status: 'proposed',
      startsAt: new Date(T0.getTime() + DEFAULT_PLAN_GRACE_SECONDS * 1000),
      author: 'agent',
      createdBy: 'user_1',
      // Einreichplan matched by title; Altbestand is on both lists and the exclusion wins.
      grundlage: [inventory[0]],
      ausgeschlossen: [inventory[1]],
    })
    expect(vi.mocked(commissionResearchRun).mock.calls[0][1]).toMatchObject({
      projectId: PROJECT,
      conversationId: 's_conv',
      question: 'Fluchtwege prüfen',
      dataSources: ['knowledge_search'],
      documents: { grundlage: [inventory[0]], ausgeschlossen: [inventory[1]] },
      plan: { planId: 'plan-1', title: 'Fluchtwege', genre: 'pruefbericht', depth: 'gutachten', sections: ['Bestand', 'Befund'] },
    })
    expect(repository.updatePlan).toHaveBeenCalledWith('plan-1', 'org_1', { runId: 'run-1' })
    expect(run.runId).toBe('run-1')
    expect(plan.runId).toBe('run-1')
  })

  it('under ask: held from the start, with no clock', async () => {
    await proposePlannedRun(session, { projectId: PROJECT, conversationId: 's_conv', draft, author: 'agent', start: { policy: 'ask' } })
    expect(vi.mocked(repository.insertPlan).mock.calls[0][0]).toMatchObject({ status: 'held', startsAt: null, heldAt: T0 })
  })

  it('a plan a person wrote is approved outright', async () => {
    await proposePlannedRun(session, { projectId: PROJECT, conversationId: 's_conv', draft, author: 'user', start: 'approved' })
    expect(vi.mocked(repository.insertPlan).mock.calls[0][0]).toMatchObject({ status: 'approved', author: 'user', approvedAt: T0 })
  })

  it('bounds the grace so a payload cannot park a run for a day', async () => {
    await proposePlannedRun(session, {
      projectId: PROJECT,
      conversationId: 's_conv',
      draft,
      author: 'agent',
      start: { policy: 'auto', graceSeconds: 100_000 },
    })
    expect(vi.mocked(repository.insertPlan).mock.calls[0][0]).toMatchObject({ startsAt: new Date(T0.getTime() + 600_000) })
  })

  it('refuses a plan with nowhere to narrate its run', async () => {
    await expect(
      proposePlannedRun(session, { projectId: PROJECT, conversationId: null, draft, author: 'agent', start: { policy: 'auto' } })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(repository.insertPlan).not.toHaveBeenCalled()
  })
})

describe('editPlan', () => {
  it('gates on the chat permissions, resolves the names, and holds a plan whose clock was running', async () => {
    await editPlan(session, PROJECT, 'plan-1', { sections: ['Bestand'], grundlage: ['OIB-Richtlinie 2'] })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, CHAT_PERMISSIONS)
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).toEqual({
      sections: ['Bestand'],
      grundlage: [inventory[2]],
      ausgeschlossen: [],
      nurGrundlage: false,
      status: 'held',
      startsAt: null,
      heldAt: T0,
    })
    // The write itself is conditioned on the plan still being editable.
    expect(vi.mocked(repository.updatePlan).mock.calls[0][3]).toEqual(['proposed', 'held', 'approved'])
  })

  it('reads a document the reader named from the project listing, which the plan was not drafted with', async () => {
    const added = { name: 'Statik.pdf', title: 'Statik', shelf: 'project' }
    await editPlan(session, PROJECT, 'plan-1', { grundlage: ['Einreichplan.pdf', 'Statik.pdf'], unterlagen: [added] })
    const patch = vi.mocked(repository.updatePlan).mock.calls[0][2]
    expect(patch.grundlage).toEqual([inventory[0], added])
    expect(patch.unterlagen).toContainEqual(added)
    // Without the addition the same name is unknown, and dropped.
    vi.mocked(repository.updatePlan).mockClear()
    await editPlan(session, PROJECT, 'plan-1', { grundlage: ['Statik.pdf'] })
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).toMatchObject({ grundlage: [] })
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).not.toHaveProperty('unterlagen')
  })

  it('„Nur diese" confines the plan while it has a Grundlage, and falls with the last document', async () => {
    await editPlan(session, PROJECT, 'plan-1', { nurGrundlage: true })
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).toMatchObject({ nurGrundlage: true })
    vi.mocked(repository.findPlanInProject).mockResolvedValue(row({ nurGrundlage: true }))
    await editPlan(session, PROJECT, 'plan-1', { grundlage: [] })
    expect(vi.mocked(repository.updatePlan).mock.calls[1][2]).toMatchObject({ grundlage: [], nurGrundlage: false })
  })

  it('refuses an edit that lost the race with the worker, rather than rewriting a started plan', async () => {
    vi.mocked(repository.updatePlan).mockResolvedValueOnce(null)
    await expect(editPlan(session, PROJECT, 'plan-1', { genre: 'bericht' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('leaves a held plan held and an approved plan approved', async () => {
    vi.mocked(repository.findPlanInProject).mockResolvedValue(row({ status: 'approved', startsAt: null }))
    await editPlan(session, PROJECT, 'plan-1', { genre: 'aktenvermerk' })
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).not.toHaveProperty('status')
  })

  it('refuses to edit a started plan: the worker already read it', async () => {
    vi.mocked(repository.findPlanInProject).mockResolvedValue(row({ status: 'started' }))
    await expect(editPlan(session, PROJECT, 'plan-1', { genre: 'bericht' })).rejects.toBeInstanceOf(ConflictError)
    expect(repository.updatePlan).not.toHaveBeenCalled()
  })
})

describe('holdPlan and startPlan', () => {
  it('holding stops the clock; starting approves and clears it', async () => {
    await holdPlan(session, PROJECT, 'plan-1')
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).toEqual({ status: 'held', startsAt: null, heldAt: T0, approvedAt: null })
    vi.mocked(repository.findPlanInProject).mockResolvedValue(row({ status: 'held', startsAt: null }))
    await startPlan(session, PROJECT, 'plan-1')
    expect(vi.mocked(repository.updatePlan).mock.calls[1][2]).toEqual({ status: 'approved', startsAt: null, approvedAt: T0 })
  })

  it('starting is gated like commissioning: it spends the project budget', async () => {
    await startPlan(session, PROJECT, 'plan-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, [...COMMISSION_PERMISSIONS])
    expect(requireProjectAccess).not.toHaveBeenCalledWith(session, PROJECT, CHAT_PERMISSIONS)
  })

  it('starting a started plan changes nothing', async () => {
    vi.mocked(repository.findPlanInProject).mockResolvedValue(row({ status: 'started' }))
    await expect(startPlan(session, PROJECT, 'plan-1')).resolves.toMatchObject({ status: 'started' })
    expect(repository.updatePlan).not.toHaveBeenCalled()
  })
})

describe('claimPlanStart — the worker asks whether it may go', () => {
  it('answers "not yet" as data while the clock runs', async () => {
    const claim = await claimPlanStart('plan-1', T0)
    expect(claim).toMatchObject({ started: false, retryAfterSeconds: 3 })
    expect(repository.updatePlan).not.toHaveBeenCalled()
  })

  it('starts a proposed plan whose clock has passed, and an approved one at once', async () => {
    const claim = await claimPlanStart('plan-1', new Date(T0.getTime() + 46_000))
    expect(claim.started).toBe(true)
    expect(vi.mocked(repository.updatePlan).mock.calls[0][2]).toMatchObject({ status: 'started', startsAt: null })

    vi.mocked(repository.findPlanById).mockResolvedValue(row({ status: 'approved', startsAt: null }))
    expect((await claimPlanStart('plan-1', T0)).started).toBe(true)
  })

  it('a hold that lands between the read and the start wins, and the worker asks again', async () => {
    vi.mocked(repository.findPlanById).mockResolvedValue(row({ status: 'approved', startsAt: null }))
    vi.mocked(repository.updatePlan).mockResolvedValueOnce(null)
    const claim = await claimPlanStart('plan-1', T0)
    expect(claim.started).toBe(false)
    expect(vi.mocked(repository.updatePlan).mock.calls[0][3]).toEqual(['approved'])
  })

  it('never starts a held plan, is idempotent on a started one, and refuses a replaced one', async () => {
    vi.mocked(repository.findPlanById).mockResolvedValue(row({ status: 'held', startsAt: null }))
    expect((await claimPlanStart('plan-1', new Date(T0.getTime() + 999_000))).started).toBe(false)

    vi.mocked(repository.findPlanById).mockResolvedValue(row({ status: 'started' }))
    expect((await claimPlanStart('plan-1', T0)).started).toBe(true)
    expect(repository.updatePlan).not.toHaveBeenCalled()

    vi.mocked(repository.findPlanById).mockResolvedValue(row({ status: 'superseded' }))
    await expect(claimPlanStart('plan-1', T0)).rejects.toBeInstanceOf(ConflictError)
  })
})
