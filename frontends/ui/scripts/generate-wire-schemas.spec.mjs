/**
 * The wire generator's unions, and the drift of what it wrote.
 *
 * `src/adapters/api/wire-v2.generated.ts` is generated from
 * `shared/wire/v2.schema.json`, itself generated from `wire_v2.py`. A stale
 * generated module type-checks perfectly, so the last test here is the gate:
 * the module in the repo must be the module this generator emits.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildWireSchemaModule,
  discriminatedUnionExpr,
  outPath,
  schemaPath,
} from './generate-wire-schemas.mjs'

describe('generate-wire-schemas', () => {
  it('emits a discriminated oneOf as z.discriminatedUnion', () => {
    const node = {
      oneOf: [{ $ref: '#/$defs/RunStarted' }, { $ref: '#/$defs/RunError' }],
      discriminator: { propertyName: 'type' },
    }
    expect(discriminatedUnionExpr(node)).toBe(
      'z.discriminatedUnion("type", [runStartedSchema, runErrorSchema])'
    )
  })

  it('joins a union nested on another key with z.union', () => {
    const node = {
      oneOf: [
        { $ref: '#/$defs/RunStarted' },
        { oneOf: [{ $ref: '#/$defs/Heartbeat' }], discriminator: { propertyName: 'name' } },
      ],
      discriminator: { propertyName: 'type' },
    }
    expect(discriminatedUnionExpr(node)).toBe(
      'z.union([z.discriminatedUnion("type", [runStartedSchema]), z.discriminatedUnion("name", [heartbeatSchema])])'
    )
  })

  it('keeps what the client sends strict, and strips unknown keys from what it receives', () => {
    const closed = (properties) => ({ type: 'object', properties, additionalProperties: false })
    const root = {
      $defs: {
        Answer: closed({ text: { type: 'string' } }),
        Result: closed({ text: { type: 'string' }, run: closed({ id: { type: 'string' } }) }),
        ClientMessage: {
          oneOf: [{ $ref: '#/$defs/Answer' }],
          discriminator: { propertyName: 'type' },
        },
      },
    }
    const generated = buildWireSchemaModule(root)
    expect(generated).toContain(
      'export const answerSchema = z.object({ "text": z.string().optional() }).strict()'
    )
    expect(generated).toContain(
      'export const resultSchema = z.object({ "text": z.string().optional(), "run": z.object({ "id": z.string().optional() }).optional() })'
    )
  })

  it('refuses a field that would generate z.any()', () => {
    const root = { $defs: { Loose: { type: 'object', properties: { x: {} } } } }
    expect(() => buildWireSchemaModule(root)).toThrow(/z\.any\(\)/)
  })

  it('wrote the module this generator emits (run `npm run generate:wire`)', () => {
    const root = JSON.parse(readFileSync(schemaPath, 'utf-8'))
    expect(readFileSync(outPath, 'utf-8')).toBe(buildWireSchemaModule(root))
  })
})
