import { describe, expect, it } from 'vitest'
import { applyPlanEdit } from './plan-edit'
import type { ResearchPlan } from './plan-types'

const plan: ResearchPlan = {
  id: 'plan-1',
  projectId: 'proj',
  conversationId: null,
  runId: null,
  author: 'agent',
  status: 'proposed',
  question: 'Frage',
  title: 'Titel',
  sections: ['A', 'B'],
  genre: 'bericht',
  depth: 'gutachten',
  grundlage: [],
  ausgeschlossen: [],
  nurGrundlage: false,
  dataSources: null,
  unterlagen: [{ name: 'Plan.pdf', title: 'Einreichplan' }],
  startsAt: '2026-09-22T08:00:30.000Z',
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:00:00.000Z',
}

describe('applyPlanEdit', () => {
  it('holds a counting plan and applies the changed fields', () => {
    const next = applyPlanEdit(plan, { sections: ['A'], depth: 'kurzpruefung' })
    expect(next).toMatchObject({ sections: ['A'], depth: 'kurzpruefung', status: 'held', startsAt: null })
  })

  it('resolves names by file name or title, and brought documents join the inventory', () => {
    const next = applyPlanEdit(plan, {
      grundlage: ['einreichplan', 'Statik.pdf'],
      unterlagen: [{ name: 'Statik.pdf', shelf: 'project' }],
    })
    expect(next.grundlage.map((doc) => doc.name)).toEqual(['Plan.pdf', 'Statik.pdf'])
    expect(next.unterlagen).toHaveLength(2)
  })

  it('lets an exclusion beat a Grundlage mark, and drops unknown names', () => {
    const next = applyPlanEdit(plan, { grundlage: ['Plan.pdf', 'Nirgends.pdf'], ausgeschlossen: ['Plan.pdf'] })
    expect(next.grundlage).toEqual([])
    expect(next.ausgeschlossen.map((doc) => doc.name)).toEqual(['Plan.pdf'])
  })

  it('confines to the Grundlage only while there is one', () => {
    expect(applyPlanEdit(plan, { grundlage: ['Plan.pdf'], nurGrundlage: true }).nurGrundlage).toBe(true)
    expect(applyPlanEdit(plan, { nurGrundlage: true }).nurGrundlage).toBe(false)
  })
})
