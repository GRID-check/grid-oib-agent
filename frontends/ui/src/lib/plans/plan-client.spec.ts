/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createPlan, editPlan, fetchPlan, holdPlan, PlanClientError, planHoldPath, planPath, plansPath, planStartPath, startPlan } from './plan-client'

const plan = {
  id: 'plan-1',
  projectId: 'proj',
  conversationId: 's_conv',
  runId: 'run-1',
  author: 'agent',
  status: 'proposed',
  question: 'Fluchtwege prüfen',
  title: 'Fluchtwege',
  sections: ['Bestand'],
  genre: 'bericht',
  depth: 'gutachten',
  grundlage: [],
  ausgeschlossen: [],
  dataSources: null,
  unterlagen: [],
  startsAt: '2026-09-22T08:00:45.000Z',
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:00:00.000Z',
}

const ok = (body: unknown) =>
  vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }))

describe('plan client', () => {
  it('names the routes the BFF serves', () => {
    expect(plansPath('p 1')).toBe('/api/projects/p%201/plans')
    expect(planPath('p', 'x/y')).toBe('/api/projects/p/plans/x%2Fy')
    expect(planHoldPath('p', 'x')).toBe('/api/projects/p/plans/x/hold')
    expect(planStartPath('p', 'x')).toBe('/api/projects/p/plans/x/start')
  })

  it('parses the plan it is answered, never casts it', async () => {
    const run = ok(plan)
    await expect(fetchPlan('proj', 'plan-1', run)).resolves.toEqual(plan)
    expect(run.mock.calls[0][0]).toBe('/api/projects/proj/plans/plan-1')
    const bad = ok({ ...plan, status: 'flying' })
    await expect(fetchPlan('proj', 'plan-1', bad)).rejects.toThrow()
  })

  it('sends an edit as JSON with PATCH, and the two controls as bare POSTs', async () => {
    const run = ok(plan)
    await editPlan('proj', 'plan-1', { sections: ['Bestand'] }, run)
    const init = run.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ sections: ['Bestand'] })
    await holdPlan('proj', 'plan-1', run)
    await startPlan('proj', 'plan-1', run)
    expect(run.mock.calls.map((call) => call[1]?.method)).toEqual(['PATCH', 'POST', 'POST'])
  })

  it('creates a plan a person wrote and answers plan and run', async () => {
    const run = ok({ plan, run: { runId: 'run-1', runMessageId: 'msg-1', conversationId: 's_conv', status: 'running' } })
    const result = await createPlan('proj', { conversationId: 's_conv', question: 'Fluchtwege', sections: ['Bestand'] }, run)
    expect(result.run.runId).toBe('run-1')
    expect(run.mock.calls[0][0]).toBe('/api/projects/proj/plans')
  })

  it('carries the status of a refusal', async () => {
    const run = vi.fn(async (_input: string, _init?: RequestInit) => new Response('nope', { status: 409 }))
    await expect(startPlan('proj', 'plan-1', run)).rejects.toBeInstanceOf(PlanClientError)
    await expect(startPlan('proj', 'plan-1', run)).rejects.toMatchObject({ status: 409 })
  })
})
