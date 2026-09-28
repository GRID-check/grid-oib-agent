/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Python tier reads, and this is what
 * keeps it from going stale.
 *
 * It REWRITES the fixture when `UPDATE_FIXTURES=1` and otherwise compares —
 * the same asymmetry `lifecycle-schema.spec.ts` carries, for the same reason: a
 * generated artifact nobody regenerates is a second hand-written contract with
 * extra steps, and one that regenerates itself silently on every run is not a
 * gate.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUN_PHASES, RUN_STATUSES, RUN_LEDGER_WIRE_SCHEMAS } from './run-ledger-types'
import { runLedgerJsonSchema } from './run-ledger-schema'

const FIXTURE = join(process.cwd(), 'tests/fixtures/run-ledger.schema.json')

type Node = Record<string, unknown>

const defs = () => runLedgerJsonSchema().$defs as Record<string, Node>

describe('run ledger JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(runLedgerJsonSchema(), null, 2)}\n`
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
    expect(Object.keys(defs()).sort()).toEqual(Object.keys(RUN_LEDGER_WIRE_SCHEMAS).sort())
  })

  it('carries both vocabularies as closed enums', () => {
    const ledger = defs().runLedger
    const properties = ledger.properties as Record<string, Node>
    expect(properties.status.enum).toEqual([...RUN_STATUSES])
    const phases = properties.phases as { items: Node }
    expect((phases.items.properties as Record<string, Node>).phase.enum).toEqual([...RUN_PHASES])
  })

  it('describes the request as a closed two-op union', () => {
    const request = defs().runLedgerRequest
    expect(request.discriminator).toEqual({ propertyName: 'op' })
    const options = request.oneOf as Array<{ properties: { op: { const: string } } }>
    expect(options.map((option) => option.properties.op.const).sort()).toEqual(['append', 'finish'])
  })

  it('refuses a step field that would name a tool', () => {
    // The op set is closed AND the step is: `additionalProperties: false` is what
    // stops a producer adding `tool` back on the side, which is the one field
    // this ledger is defined by not having.
    const step = ((defs().runLedger.properties as Record<string, Node>).steps as { items: Node })
      .items
    expect(step.additionalProperties).toBe(false)
    expect(Object.keys(step.properties as Node).sort()).toEqual([
      'docs',
      'findings',
      'id',
      'intent',
      'openPoints',
      'phase',
      'startedAt',
    ])
  })
})
