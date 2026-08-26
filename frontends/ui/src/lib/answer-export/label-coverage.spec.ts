/**
 * @vitest-environment node
 */

/**
 * The guards that keep an exported document German.
 *
 * Four of them, all derived from `shared/cards/schemas.json` and never from a
 * hand-written list:
 *
 *   1. every field name the walker can label has a word (`fields`);
 *   2. every card type that can head a block has a word (`cardTypes`);
 *   3. every per-path label override still names a field the schema has, and
 *      conditions only on a sibling that can hold the member it names
 *      (`fieldsByPath`);
 *   4. every member of every enum an exported card can carry has a word, and
 *      no word survives its member (`values`).
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
 * Same shape and same self-guard as `key-coverage.spec.ts`: one test asserts
 * the walk found something, because a traversal that silently stopped matching
 * would make every assertion around it pass over nothing at all.
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
  enum?: unknown[]
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

/** Every payload path the walker can stand at, as it spells them. */
const schemaPaths = new Set<string>()

/**
 * The closed vocabularies, by the path they sit at.
 *
 * A `Literal` reaches the schema inlined as `enum`, wrapped in an `anyOf` when
 * the field is optional — so both forms are unwrapped here. This is the map the
 * value guard below is built from: it is the schema's own statement of what a
 * card may say, and nothing at runtime would notice a member missing a word.
 */
const vocabularyAt = new Map<string, Set<string>>()

const enumMembers = (node: JsonSchemaNode | undefined, depth = 0): Set<string> => {
  const found = new Set<string>()
  if (!node || depth > 8) return found
  for (const member of node.enum ?? []) if (typeof member === 'string') found.add(member)
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    for (const member of enumMembers(branch, depth + 1)) found.add(member)
  }
  return found
}

const collect = (defName: string, path: string, top: boolean, seen: Set<string>) => {
  if (seen.has(defName)) return // a self-referential model would otherwise not terminate
  const nextSeen = new Set(seen).add(defName)
  for (const [name, property] of Object.entries(defs[defName]?.properties ?? {})) {
    if (name === 'type') continue
    if (top && SKIPPED_FIELDS.has(name)) continue
    const here = `${path}.${name}`
    labelledFields.set(name, [...(labelledFields.get(name) ?? []), here])
    schemaPaths.add(here)
    const members = enumMembers(property)
    if (members.size > 0) vocabularyAt.set(here, members)
    for (const nested of referencedDefs(property)) {
      if (defs[nested]?.properties) collect(nested, here, false, nextSeen)
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
  // prints its title and one fixed sentence — a heading, but no fields. A
  // `diagram` prints its title, the fence's own label, the source, the caption
  // and the Fundstelle, none of which the WALKER labels: the caption and the
  // source stand on their own (a caption under a label is not a caption), and
  // the Fundstelle reuses `fields.reference`, which every other card already
  // demands. So all three head a block and only `content` is walked.
  if (kind === 'chrome') continue
  exportedTypes.push(type)
  if (kind === 'content') {
    walkedTypes.push(type)
    collect(defName, type, true, new Set())
  }
}

const fields = en.answerExport.fields as Record<string, string | undefined>
const cardTypes = en.answerExport.cardTypes as Record<string, string | undefined>
const values = en.answerExport.values as Record<string, Record<string, string | undefined>>

/** `{a: {b: 'x'}}` → `a.b`. The dictionary's own nesting mirrors the payload. */
const flattenKeys = (node: unknown, prefix: string, into: Set<string>): Set<string> => {
  if (typeof node === 'string') {
    into.add(prefix)
    return into
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, into)
    }
  }
  return into
}

const overrideKeys = [...flattenKeys(en.answerExport.fieldsByPath, '', new Set<string>())].sort()

/** `calculation.limit.value?comparator=between` → its three parts. */
const parseOverride = (key: string) => {
  const [path, condition] = key.split('?')
  const [sibling, member] = condition ? condition.split('=') : []
  return { path, sibling, member }
}

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
    // Same for the vocabularies: a `enumMembers` that stopped unwrapping
    // `anyOf` would silently stop asking for words for every optional enum.
    expect(vocabularyAt.size).toBeGreaterThan(40)
    expect(vocabularyAt.get('calculation.limit.comparator')).toContain('between')
    expect(vocabularyAt.get('document_checklist.items.status')).toContain('present')
  })
})

/**
 * The guard on the per-path label overrides.
 *
 * `fieldsByPath` is the one departure from the dictionary's one-entry-per-name
 * rule, and it is keyed on a path the SCHEMA owns — `calculation.limit.value`
 * exists because `CalculationCard.limit` is a `CalculationLimit` with a `value`.
 * Rename either and the override stops applying, silently, and the field goes
 * back to the flat map's „Ist“ over a limit. So every key is resolved here: an
 * override mechanism that can rot without anyone noticing is worse than the bug
 * it was added for.
 */
describe('every per-path label override still points at a field that exists', () => {
  it('names a path the card schema has', () => {
    const dangling = overrideKeys
      .filter((key) => !schemaPaths.has(parseOverride(key).path))
      .map((key) => `${key}  (no such path in shared/cards/schemas.json)`)

    expect(
      dangling,
      'These `fieldsByPath` keys name a payload path no card carries any more. ' +
        'Either the field was renamed — follow it — or the card was removed and ' +
        'the override with it. A key that resolves to nothing is a label that ' +
        'silently reverted to the flat map.'
    ).toEqual([])
  })

  it('conditions only on a sibling field that exists and a member it can hold', () => {
    const broken: string[] = []
    for (const key of overrideKeys) {
      const { path, sibling, member } = parseOverride(key)
      if (!sibling) continue
      const parent = path.split('.').slice(0, -1).join('.')
      const siblingPath = `${parent}.${sibling}`
      if (!schemaPaths.has(siblingPath)) {
        broken.push(`${key}  (no sibling ${siblingPath})`)
        continue
      }
      if (!vocabularyAt.get(siblingPath)?.has(member)) {
        broken.push(`${key}  (${siblingPath} cannot hold '${member}')`)
      }
    }

    expect(
      broken,
      'A conditional override reads „use this label when the sibling says that“. ' +
        'The sibling has to exist and the member has to be one it can actually ' +
        'carry, or the condition is never true and the override never applies.'
    ).toEqual([])
  })

  it('does not condition one path on two different siblings', () => {
    // `overrideKey` in cards.ts walks the record's own keys and takes the first
    // variant that matches, so two variants keyed on different siblings would
    // resolve by jsonb key order — which Postgres does not preserve.
    const siblingsPerPath = new Map<string, Set<string>>()
    for (const key of overrideKeys) {
      const { path, sibling } = parseOverride(key)
      if (!sibling) continue
      siblingsPerPath.set(path, (siblingsPerPath.get(path) ?? new Set()).add(sibling))
    }
    const ambiguous = [...siblingsPerPath.entries()]
      .filter(([, siblings]) => siblings.size > 1)
      .map(([path, siblings]) => `${path}  (${[...siblings].sort().join(', ')})`)

    expect(ambiguous, 'which override wins would depend on stored key order').toEqual([])
  })
})

/**
 * The guard that keeps a payload's own vocabulary out of the document.
 *
 * The walker prints what the card says. `direction: 'tightens'` is not a word a
 * Behörde reads, and the card charter forbids a card whose meaning only the
 * pixels carry (§D5) — so every member of every `Literal` in `models.py` that
 * an exported card can reach needs a word in `answerExport.values`.
 *
 * Derived from the schema for the same reason as the label guard above: a
 * member added to a `Literal` has to arrive here as a failing assertion naming
 * it, not as an English word in a German Bauakt that nobody notices until the
 * file has left the product. The reverse direction is asserted too — a word for
 * a member no card can emit any more is dead weight that hides the next real
 * gap.
 */
describe('every value an exported card can print is a translated word', () => {
  /** field name → the members every card that has that field can hold. */
  const reachable = new Map<string, Set<string>>()
  for (const [path, members] of vocabularyAt) {
    const name = path.split('.').pop() as string
    const known = reachable.get(name) ?? new Set<string>()
    for (const member of members) known.add(member)
    reachable.set(name, known)
  }

  it('names every member of every enum a card carries', () => {
    const untranslated: string[] = []
    for (const [name, members] of reachable) {
      for (const member of [...members].sort()) {
        if (typeof values[name]?.[member] !== 'string') {
          untranslated.push(`${name}.${member}`)
        }
      }
    }

    expect(
      untranslated.sort(),
      'These enum members have no word in `answerExport.values`, so the walker ' +
        'prints the wire value: „Wirkung | tightens“, „Rang | verordnung“. Add ' +
        'each one to src/i18n/dictionaries/en/answer-export.ts; German follows ' +
        'by compile error.'
    ).toEqual([])
  })

  it('carries no word for a member the catalogue can no longer emit', () => {
    const dead: string[] = []
    for (const [name, members] of Object.entries(values)) {
      for (const member of Object.keys(members)) {
        if (!reachable.get(name)?.has(member)) dead.push(`${name}.${member}`)
      }
    }

    expect(
      dead.sort(),
      'These words translate a member no exported card can hold. Either the ' +
        '`Literal` lost it — delete the word — or the field is no longer ' +
        'reachable, in which case the whole vocabulary is stale.'
    ).toEqual([])
  })
})
