/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema the agent's cross-project tools are tested against
 * stays the zod contract: rewritten with `UPDATE_FIXTURES=1`, compared otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossProjectJsonSchema } from './cross-project-schema'
import {
  CROSS_PROJECT_FACT_BAUWEISEN,
  CROSS_PROJECT_FACT_BUNDESLAENDER,
  CROSS_PROJECT_FACT_NUTZUNGEN,
  CROSS_PROJECT_FACT_VORHABENSARTEN,
  CROSS_PROJECT_WIRE_SCHEMAS,
  crossProjectListRequestSchema,
  crossProjectSearchRequestSchema,
} from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/cross-project.schema.json')

describe('cross-project JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(crossProjectJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(crossProjectJsonSchema().$defs as object).sort()).toEqual(
      Object.keys(CROSS_PROJECT_WIRE_SCHEMAS).sort()
    )
  })

  it('fills the defaults a tool may leave out, and refuses a day that is not one', () => {
    expect(crossProjectSearchRequestSchema.parse({ query: 'Dachdetail' })).toMatchObject({
      scope: 'similar',
      projectIds: [],
      documentTypes: [],
      disciplines: [],
      offset: 0,
      limit: 10,
      openFoldersOnly: false,
    })
    expect(crossProjectSearchRequestSchema.safeParse({ query: 'Dach', from: '2026-02-30' }).success).toBe(false)
    expect(crossProjectSearchRequestSchema.safeParse({ query: 'Dach', documentTypes: ['Dach'] }).success).toBe(false)
  })

  it('takes the fact filter in the intake’s own tokens and refuses anything else rather than ignoring it', () => {
    const facts = (projectFacts: unknown) => crossProjectSearchRequestSchema.safeParse({ query: 'Dachdetail', projectFacts })
    const listed = (projectFacts: unknown) => crossProjectListRequestSchema.safeParse({ projectFacts })

    expect(crossProjectSearchRequestSchema.parse({ query: 'Dachdetail' }).projectFacts).toBeUndefined()
    expect(
      facts({ bundesland: ['tirol'], gebaeudeklasse: [4, 5], bauweise: ['holzbau'], nutzungen: ['wohnen'], vorhabensart: ['neubau'] })
        .success
    ).toBe(true)
    expect(listed({ bundesland: ['niederoesterreich'] }).success).toBe(true)
    // Each vocabulary is the wizard's, „noch offen" and a site abroad left out (neither is a value a project can match).
    expect(CROSS_PROJECT_FACT_BUNDESLAENDER).toContain('vorarlberg')
    expect(CROSS_PROJECT_FACT_BUNDESLAENDER).not.toContain('ausserhalb_oesterreichs')
    expect(CROSS_PROJECT_FACT_BAUWEISEN).not.toContain('offen')
    expect(CROSS_PROJECT_FACT_NUTZUNGEN).toContain('gastro')
    expect(CROSS_PROJECT_FACT_VORHABENSARTEN).toContain('nutzungsaenderung')
    for (const refused of [
      { bundesland: ['Tirol'] },
      { bundesland: ['ausserhalb_oesterreichs'] },
      { gebaeudeklasse: [6] },
      { gebaeudeklasse: ['GK4'] },
      { bauweise: ['offen'] },
      { nutzungen: [] },
      { farbe: ['rot'] },
    ]) {
      expect(facts(refused).success, JSON.stringify(refused)).toBe(false)
      expect(listed(refused).success, JSON.stringify(refused)).toBe(false)
    }
  })
})
