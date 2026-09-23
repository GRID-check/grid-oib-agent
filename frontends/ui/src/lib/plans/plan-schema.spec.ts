/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Python tier reads, and this is what
 * keeps it from going stale: it REWRITES the fixture under `UPDATE_FIXTURES=1`
 * and otherwise compares.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAN_GENRES, PLAN_STATUSES, RESEARCH_PLAN_WIRE_SCHEMAS, researchPlanSchema } from './plan-types'
import { researchPlanJsonSchema } from './plan-schema'

const FIXTURE = join(process.cwd(), 'tests/fixtures/research-plan.schema.json')

type Node = Record<string, unknown>

const defs = () => researchPlanJsonSchema().$defs as Record<string, Node>

describe('research plan JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(researchPlanJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') {
      writeFileSync(FIXTURE, generated, 'utf8')
    }
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture ' +
        'in the same change, so the Python models and this tier cannot disagree.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(defs()).sort()).toEqual(Object.keys(RESEARCH_PLAN_WIRE_SCHEMAS).sort())
  })

  it('carries the lifecycle and the genres as closed enums', () => {
    const plan = defs().researchPlan
    const properties = plan.properties as Record<string, Node>
    expect(properties.status.enum).toEqual([...PLAN_STATUSES])
    expect(properties.genre.enum).toEqual([...PLAN_GENRES])
    expect(plan.additionalProperties).toBe(false)
  })

  it('refuses a plan with no sections, because a run needs something to cover', () => {
    const base = {
      id: 'p1',
      projectId: 'proj',
      conversationId: null,
      runId: null,
      author: 'agent',
      status: 'proposed',
      question: 'Fluchtwege',
      title: 'Fluchtwege',
      sections: [],
      genre: 'bericht',
      depth: 'gutachten',
      grundlage: [],
      ausgeschlossen: [],
      dataSources: null,
      unterlagen: [],
      startsAt: null,
      heldAt: null,
      approvedAt: null,
      startedAt: null,
      createdAt: '2026-09-22T08:00:00.000Z',
      updatedAt: '2026-09-22T08:00:00.000Z',
    }
    expect(researchPlanSchema.safeParse(base).success).toBe(false)
    expect(researchPlanSchema.safeParse({ ...base, sections: ['Bestand'] }).success).toBe(true)
  })
})
