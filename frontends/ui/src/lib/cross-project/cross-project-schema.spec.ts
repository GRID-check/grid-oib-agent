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
import { CROSS_PROJECT_WIRE_SCHEMAS, crossProjectSearchRequestSchema } from './types'

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
      scope: 'all',
      projectIds: [],
      documentTypes: [],
      disciplines: [],
      offset: 0,
      limit: 10,
    })
    expect(crossProjectSearchRequestSchema.safeParse({ query: 'Dach', from: '2026-02-30' }).success).toBe(false)
    expect(crossProjectSearchRequestSchema.safeParse({ query: 'Dach', documentTypes: ['Dach'] }).success).toBe(false)
  })
})
