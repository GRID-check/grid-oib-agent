/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what Piloti's canvas tools (`src/aiq_agent/tools/canvas/`) are
 * tested against, and this keeps it from going stale: it REWRITES the fixture
 * when `UPDATE_FIXTURES=1` and otherwise compares.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentAnnotationsJsonSchema } from './annotation-schema'
import { ANNOTATION_WIRE_SCHEMAS } from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/document-annotations.schema.json')

describe('document annotations JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(documentAnnotationsJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(documentAnnotationsJsonSchema().$defs as object).sort()).toEqual(
      Object.keys(ANNOTATION_WIRE_SCHEMAS).sort()
    )
  })

  it('describes the request as a closed union over its ops: the Anmerkungen, what the asker asks for, and the room', () => {
    const request = (documentAnnotationsJsonSchema().$defs as Record<string, { oneOf?: unknown[]; anyOf?: unknown[] }>)
      .InternalAnnotationRequest
    const options = (request.oneOf ?? request.anyOf) as Array<{ properties: { op: { const: string } } }>
    expect(options.map((option) => option.properties.op.const).sort()).toEqual(['create', 'delete', 'highlight', 'leave', 'list', 'look', 'point', 'propose', 'reply', 'room', 'update'])
  })
})
