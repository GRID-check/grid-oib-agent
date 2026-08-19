/**
 * @vitest-environment node
 */

/**
 * The guard that keeps an exported document German.
 *
 * `cards.ts` is a generic field walker: it labels every field it meets with
 * `t('fields.<name>')`. When that key is missing the translator answers with the
 * dot-path, and `fieldLabel` catches that and HUMANIZES the field name instead —
 * `current_step` becomes „Current step“, `to_value` becomes „To value“. Those
 * are readable, plausible, and English, printed inside a German compliance
 * document next to labels that ARE German („Fundstelle“, „Einheit“). Nothing
 * throws, nothing warns in production, and the file has already left the
 * product by the time anyone reads it.
 *
 * That degradation is deliberate and must stay: a stored card carrying a field
 * this build has never heard of has to export its DATA, and a thrown error or a
 * blank label would cost the reader a finding. So the fallback cannot be
 * removed — it has to be made unreachable for every field the catalogue can
 * actually produce, and kept unreachable. This file is the "kept" half.
 *
 * ## Derived from the schema, never from a list
 *
 * The field names come out of `shared/cards/schemas.json` — the canonical card
 * schema generated from `models.py`, and the file `generated.ts` is itself
 * generated from. A hand-written list here would be exactly the mistake
 * `answer-document.spec.ts` already made once: its "every card in the
 * catalogue" was a claim about an array, not about the catalogue, and thirteen
 * card types sat outside it. A new card type must arrive here as a failing
 * assertion naming its untranslated fields, without anyone remembering to
 * extend anything.
 *
 * Same shape and same self-guard as `key-coverage.spec.ts`: the last test
 * asserts the walk found something, because a traversal that silently stopped
 * matching would make every assertion above pass over nothing at all.
 *
 * ## Only English is asserted
 *
 * Each German namespace is annotated `typeof en.<ns>`, so a key present in
 * English and missing in German is already a compile error. The gap this file
 * closes is the other one: a key missing from BOTH, which no type can see.
 */

import { describe, expect, it } from 'vitest'
import { en } from '@/i18n/dictionaries/en'
// The canonical card JSON Schema, generated from `models.py`. Reached by path
// because it lives above the app root, exactly as `nested-fields.spec.ts` and
// `scripts/generate-card-schemas.mjs` reach it.
import cardJsonSchema from '../../../../../shared/cards/schemas.json'
import { exportKindOf, SKIPPED_FIELDS } from './cards'

interface JsonSchemaNode {
  $ref?: string
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  items?: JsonSchemaNode
  const?: unknown
  default?: unknown
  properties?: Record<string, JsonSchemaNode>
}
interface JsonSchemaDocument {
  $defs: Record<string, JsonSchemaNode>
  oneOf: Array<{ $ref: string }>
}

const document = cardJsonSchema as unknown as JsonSchemaDocument
const defs = document.$defs
const cardDefNames = document.oneOf.map((entry) => entry.$ref.split('/').pop() as string)

/** The card type a `$def` describes, off its `type` literal. */
const cardTypeOf = (defName: string): string | undefined => {
  const node = defs[defName]?.properties?.type
  const value = node?.const ?? node?.default
  return typeof value === 'string' ? value : undefined
}

/** Every `$def` this property can reach without leaving the field. */
const referencedDefs = (node: JsonSchemaNode | undefined, found = new Set<string>(), depth = 0) => {
  if (!node || depth > 8) return found
  if (typeof node.$ref === 'string') found.add(node.$ref.split('/').pop() as string)
  for (const member of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    referencedDefs(member, found, depth + 1)
  }
  referencedDefs(node.items, found, depth + 1)
  return found
}

/**
 * Every field name the walker can label, per card type.
 *
 * Recursive, because the walker is: `objectTable` heads a column with
 * `fieldLabel(key)` for every key of every row object, and `nestedText` writes
 * `fieldLabel(key): value` for a record inside a cell. So a name buried three
 * levels down (`calculation.steps[].operands[].factor`) reaches the document
 * exactly as a top-level one does.
 *
 * The exclusions mirror the walker precisely: `SKIPPED_FIELDS` at the card's own
 * level, and only the `type` discriminator below it.
 */
const labelledFields = new Map<string, string[]>()

const collect = (defName: string, path: string, top: boolean, seen: Set<string>) => {
  if (seen.has(defName)) return // a self-referential model would otherwise not terminate
  const nextSeen = new Set(seen).add(defName)
  for (const [name, property] of Object.entries(defs[defName]?.properties ?? {})) {
    if (name === 'type') continue
    if (top && SKIPPED_FIELDS.has(name)) continue
    labelledFields.set(name, [...(labelledFields.get(name) ?? []), `${path}.${name}`])
    for (const nested of referencedDefs(property)) {
      if (defs[nested]?.properties) collect(nested, `${path}.${name}`, false, nextSeen)
    }
  }
}

/** Card types the document actually renders, by what they contribute to it. */
const exportedTypes: string[] = []
const walkedTypes: string[] = []
for (const defName of cardDefNames) {
  const type = cardTypeOf(defName)
  if (!type) continue
  const kind = exportKindOf(type)
  // Chrome contributes nothing at all, so it can carry no label. A live card
  // prints its title and one fixed sentence — a heading, but no fields.
  if (kind === 'chrome') continue
  exportedTypes.push(type)
  if (kind !== 'live') {
    walkedTypes.push(type)
    collect(defName, type, true, new Set())
  }
}

const fields = en.answerExport.fields as Record<string, string | undefined>
const cardTypes = en.answerExport.cardTypes as Record<string, string | undefined>

describe('every label an exported card can print is a translated word', () => {
  it('names every field the walker labels', () => {
    const humanized = [...labelledFields.entries()]
      .filter(([name]) => typeof fields[name] !== 'string')
      .map(([name, paths]) => `${name}  (${paths.sort().join(', ')})`)

    expect(
      humanized.sort(),
      'These field names have no entry in `answerExport.fields`, so `fieldLabel` ' +
        'humanizes them — a German compliance document prints „Current step“ and ' +
        '„To value“ beside „Fundstelle“ and „Einheit“. Add each one to ' +
        'src/i18n/dictionaries/en/answer-export.ts; German follows by compile error.'
    ).toEqual([])
  })

  it('names every card type, for the cards that carry no title of their own', () => {
    // `legal_basis` and `verdict_header` have no `title` field at all, and
    // `callout`, `key_takeaways` and the rest carry an optional one — but the
    // fallback is reachable for EVERY type, because a stored card is untrusted
    // jsonb whose `title` may be absent or blank whatever the schema says.
    const humanized = exportedTypes.filter((type) => typeof cardTypes[type] !== 'string')

    expect(
      humanized.sort(),
      'These card types have no entry in `answerExport.cardTypes`, so a card of ' +
        'this type with no usable title is headed with a humanized form of its ' +
        'own type name — „Verdict header“ at the top of a German finding.'
    ).toEqual([])
  })

  it('is actually walking the catalogue', () => {
    // Guards the guard: a traversal that stopped following `$ref`s, or a
    // classification that called everything chrome, would leave the assertions
    // above asserting nothing.
    expect(walkedTypes.length).toBeGreaterThan(30)
    expect(labelledFields.size).toBeGreaterThan(100)
    // The deep path is the one a shallower walk would lose first.
    expect(labelledFields.get('factor')).toContain('calculation.steps.operands.factor')
  })
})
