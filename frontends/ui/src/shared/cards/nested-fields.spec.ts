/**
 * The guard that a card's NESTED fields are actually validated.
 *
 * `generate-card-schemas.mjs` used to flatten every nested `$ref` to
 * `z.any()`, because `json-schema-to-zod` has no `$ref` resolution and a
 * single `$def` handed to it in isolation cannot see the siblings it points
 * at. The result was not weak validation of nested card fields, it was none:
 * `{ type: 'verdict_header', …, reference: 'banana' }` was a valid card, and
 * because `z.any()` also accepts `undefined`, 14 card types could arrive
 * missing a field `models.py` requires. Eight of those threw during render,
 * and with no error boundary between a card and its route that unmounted the
 * whole thread rather than dropping the one card.
 *
 * So the assertion here is deliberately EXHAUSTIVE over the canonical JSON
 * Schema rather than a handful of examples: every field that `schemas.json`
 * describes with a `$ref` must be a field the Zod mirror really checks. A
 * regression in the generator brings this file down, whichever card type it
 * happens to hit first.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as generated from './generated'
import { gridCardSchema, validateGridCards } from './schemas'
// The canonical card JSON Schema, generated from `models.py` and the input the
// Zod mirror is generated FROM. Loaded at runtime (it lives above the app
// root, outside the Docker build context) — see the helper for why a static
// import breaks the production image build.
import { loadCardJsonSchema } from '@/test-utils/card-json-schema'

const cardJsonSchema = loadCardJsonSchema()

interface JsonSchemaDocument {
  $defs: Record<string, JsonSchemaNode>
  oneOf: Array<{ $ref: string }>
}
interface JsonSchemaNode {
  $ref?: string
  anyOf?: JsonSchemaNode[]
  items?: JsonSchemaNode
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
}

const document = cardJsonSchema as unknown as JsonSchemaDocument
const defs = document.$defs
const cardDefNames = document.oneOf.map((entry) => entry.$ref.split('/').pop() as string)

const constOf = (node: JsonSchemaNode | undefined): string | undefined => {
  const literal = (node as { const?: unknown; default?: unknown } | undefined)?.const
  const fallback = (node as { default?: unknown } | undefined)?.default
  const value = literal ?? fallback
  return typeof value === 'string' ? value : undefined
}

/** Peel `.optional()`, `.nullable()`, `.default()`, arrays and unions. */
function bottomsOutInAny(schema: z.ZodTypeAny, depth = 0): boolean {
  if (depth > 8) return false
  const def = schema._def as { typeName: string; [key: string]: unknown }
  switch (def.typeName) {
    case 'ZodAny':
    case 'ZodUnknown':
      return true
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return bottomsOutInAny(def.innerType as z.ZodTypeAny, depth + 1)
    case 'ZodArray':
      return bottomsOutInAny(def.type as z.ZodTypeAny, depth + 1)
    case 'ZodUnion':
      return (def.options as z.ZodTypeAny[]).some((option) => bottomsOutInAny(option, depth + 1))
    default:
      return false
  }
}

/** Does this property's JSON Schema reach a `$ref` without leaving the field? */
function describesARef(node: JsonSchemaNode | undefined, depth = 0): boolean {
  if (!node || depth > 8) return false
  if (typeof node.$ref === 'string') return true
  if (node.items && describesARef(node.items, depth + 1)) return true
  return (node.anyOf ?? []).some((member) => describesARef(member, depth + 1))
}

/** Every `<card type>.<field>` the canonical schema describes with a `$ref`. */
const nestedFields = cardDefNames.flatMap((defName) => {
  const definition = defs[defName]
  const cardType = constOf(definition.properties?.type)
  if (!cardType) return []
  return Object.entries(definition.properties ?? {})
    .filter(([, property]) => describesARef(property))
    .map(([field]) => ({ defName, cardType, field, required: (definition.required ?? []).includes(field) }))
})

const schemaFor = (defName: string) =>
  (generated as unknown as Record<string, z.ZodObject<z.ZodRawShape>>)[
    `${defName[0].toLowerCase()}${defName.slice(1)}Schema`
  ]

describe('nested card fields are validated, not waved through', () => {
  it('finds nested fields to check at all', () => {
    // A zero here would make every assertion below vacuously true.
    expect(nestedFields.length).toBeGreaterThan(50)
  })

  it.each(nestedFields.map((entry) => [`${entry.cardType}.${entry.field}`, entry] as const))(
    '%s is a real schema, not z.any()',
    (_label, entry) => {
      const field = schemaFor(entry.defName).shape[entry.field]
      expect(
        bottomsOutInAny(field),
        `${entry.cardType}.${entry.field} is described by a $ref in shared/cards/schemas.json but ` +
          'the Zod mirror accepts anything for it. The generator dropped the reference — see ' +
          'scripts/generate-card-schemas.mjs.'
      ).toBe(false)
    }
  )

  it('rejects a card whose nested reference is a bare string', () => {
    const result = gridCardSchema.safeParse({
      type: 'verdict_header',
      subject: 'Erforderliche Geländerhöhe',
      verdict: '1,10 m',
      reference: 'banana',
    })
    expect(result.success).toBe(false)
  })

  it.each(nestedFields.filter((entry) => entry.required).map((entry) => [entry.cardType, entry] as const))(
    'rejects a %s that is missing its required nested field',
    (_cardType, entry) => {
      const fixture = { type: entry.cardType, ...Object.fromEntries(
        Object.keys(defs[entry.defName].properties ?? {}).map((field) => [field, undefined])
      ) }
      // Only the absence of THIS field is under test, so hand the parser a
      // card that is otherwise whatever the type demands: a missing required
      // field is a rejection either way, and the assertion is that removing
      // the nested one is enough on its own to fail.
      delete (fixture as Record<string, unknown>)[entry.field]
      const result = schemaFor(entry.defName).safeParse(fixture)
      expect(result.success).toBe(false)
      expect(
        result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')),
        `${entry.cardType}.${entry.field} is required by models.py but its absence was not reported`
      ).toContain(entry.field)
    }
  )

  it('still accepts every card the gallery ships', async () => {
    // The other half of the guard: tightening must not start dropping cards
    // that render fine today. `preview-fixtures.ts` runs its raw fixtures
    // through `validateGridCards`, so a rejected one is simply absent.
    const { CARD_PREVIEW_FIXTURES, PREVIEW_EXCLUDED } = await import('@/features/grid-cards/preview-fixtures')
    const previewable = [...gridCardSchema.optionsMap.keys()]
      .filter((type): type is string => typeof type === 'string')
      .filter((type) => !(type in PREVIEW_EXCLUDED))
    expect(Object.keys(CARD_PREVIEW_FIXTURES).sort()).toEqual(previewable.sort())
  })

  it('holds the position of the malformed card and keeps the rest of the answer', () => {
    // The failure mode this whole line of work is about: one bad card must
    // cost one card, not the thread — and not the positions after it, which
    // `[[card:N]]` markers and persisted decisions address by index.
    const kept = validateGridCards([
      { type: 'verdict_header', subject: 'a', verdict: 'b', reference: 'banana' },
      { type: 'summary', title: 'Zusammenfassung', content: 'Alles gut.' },
    ])
    expect(kept).toHaveLength(2)
    expect(kept.map((card) => card?.type)).toEqual([undefined, 'summary'])
  })
})
