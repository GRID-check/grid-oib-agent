/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Python tier reads, and this is what
 * keeps it from going stale.
 *
 * It REWRITES the fixture when `UPDATE_FIXTURES=1` and otherwise compares. That
 * asymmetry is the point: a generated artifact nobody regenerates is a second
 * hand-written contract with extra steps, and one that regenerates itself
 * silently on every run is not a gate.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { documentLifecycleJsonSchema, toJsonSchema } from './lifecycle-schema'
import {
  DOCUMENT_LIFECYCLE_WIRE_SCHEMAS,
  internalDocumentVersionRequestSchema,
} from './lifecycle-types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/document-lifecycle.schema.json')

describe('document lifecycle JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(documentLifecycleJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') {
      writeFileSync(FIXTURE, generated, 'utf8')
    }
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture ' +
        'in the same change, so the Python tool and this tier cannot disagree.',
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    const schema = documentLifecycleJsonSchema()
    expect(Object.keys(schema.$defs as object).sort()).toEqual(
      Object.keys(DOCUMENT_LIFECYCLE_WIRE_SCHEMAS).sort(),
    )
  })

  it('describes the internal request as a closed discriminated union', () => {
    const node = toJsonSchema(internalDocumentVersionRequestSchema)
    expect(node.discriminator).toEqual({ propertyName: 'op' })
    const options = node.oneOf as Array<{ properties: { op: { const: string } } }>
    // The op set is closed here as well as in the route: a fourth branch would
    // have to be added deliberately, in a file a reviewer reads.
    expect(options.map((option) => option.properties.op.const).sort()).toEqual([
      'create',
      'submit',
      'update',
    ])
  })

  it('refuses to describe a shape it does not understand, rather than emitting {}', () => {
    // The bound this converter is honest about: an unsupported node is a failing
    // test, not a JSON Schema that permits anything. That failure is the signal
    // to take the zod-to-json-schema dependency.
    expect(() => toJsonSchema(z.map(z.string(), z.string()))).toThrow(/cannot describe/)
  })
})
