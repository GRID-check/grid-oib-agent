/**
 * Generate the chat wire v2 Zod module (`src/adapters/api/wire-v2.generated.ts`)
 * from `shared/wire/v2.schema.json`, which is itself generated from the Pydantic
 * models in `src/aiq_agent/common/wire_v2.py`. One contract, one source.
 *
 * Run with: `npm run generate:wire`
 *
 * It reuses the card generator's `$ref`-by-name machinery (each `$def` one
 * exported const, emitted in dependency order) and adds the two things the wire
 * has and the cards do not:
 *
 * - **Discriminated unions anywhere.** `json-schema-to-zod` turns a `oneOf` into
 *   a `z.any().superRefine(...)`, which parses by trying every member and infers
 *   as `any`. A `oneOf` that carries a `discriminator` is emitted here as
 *   `z.discriminatedUnion`, which dispatches on one key and infers the union. A
 *   member that is itself a union on another key (AG-UI's `CUSTOM` events, told
 *   apart by `name`) cannot sit inside a zod 3 `discriminatedUnion`, so the
 *   outer union becomes `z.union([byType, byName])`.
 * - **Opaque payloads as `unknown`.** A `dict[str, Any]` (a card, a masthead,
 *   whose own contracts validate them downstream) is `z.record(z.unknown())`,
 *   never `z.any()`: nothing downstream may read into it unchecked.
 * - **Strict one way only.** Every wire model forbids extra fields
 *   (`additionalProperties: false`), which `json-schema-to-zod` renders as
 *   `.strict()`. That is right for what the client SENDS: the server refuses an
 *   unknown field, and so does the spec that holds `client.jsonl` to it. It is
 *   wrong for what the client RECEIVES: a browser tab outlives a deploy, so the
 *   bundle reading a frame is often older than the server that wrote it, and a
 *   strict object turns every additive field (`quote_stamps`,
 *   `reasoning_effort`) into a frame that does not parse, a dropped `seq`, and a
 *   turn that never settles. So every `$def` outside `ClientMessage`'s closure
 *   is emitted without `.strict()`: zod's default strips the keys it does not
 *   know. Nothing reads an undeclared key, so `.passthrough()` would only carry
 *   them untyped. Unions still discriminate on their literal (`type`, `name`,
 *   `kind`), which stripping does not touch.
 */

import { jsonSchemaToZod } from 'json-schema-to-zod'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  exportName,
  referencedDefNames,
  refParserOverride,
  refToDefName,
  topologicallyOrderedDefNames,
} from './generate-card-schemas.mjs'

/** The union of everything the client sends; its closure stays strict. */
const CLIENT_ROOT = 'ClientMessage'

/** `name` and every `$def` it reaches, at any depth. */
export function defClosure(defs, name) {
  const seen = new Set()
  const pending = [name]
  while (pending.length > 0) {
    const next = pending.pop()
    if (seen.has(next) || !defs[next]) continue
    seen.add(next)
    pending.push(...referencedDefNames(defs[next]))
  }
  return seen
}

/**
 * A copy of `node` with every `additionalProperties: false` dropped, so the
 * object strips unknown keys instead of refusing them. A `$ref` is left alone:
 * the def it names is decided on its own.
 */
export function tolerateUnknownKeys(node) {
  if (Array.isArray(node)) return node.map(tolerateUnknownKeys)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'additionalProperties' && value === false))
      .map(([key, value]) => [key, tolerateUnknownKeys(value)])
  )
}

/** `z.discriminatedUnion` for a discriminated `oneOf`; nested unions joined with `z.union`. */
export function discriminatedUnionExpr(node) {
  const key = node.discriminator.propertyName
  const objects = node.oneOf.filter((member) => typeof member.$ref === 'string')
  const nested = node.oneOf.filter((member) => Array.isArray(member.oneOf))
  if (objects.length + nested.length !== node.oneOf.length) {
    throw new Error(
      `A discriminated oneOf on '${key}' has a member that is neither a $ref nor a union`
    )
  }
  const byKey = `z.discriminatedUnion(${JSON.stringify(key)}, [${objects
    .map((member) => exportName(refToDefName(member.$ref)))
    .join(', ')}])`
  if (nested.length === 0) return byKey
  return `z.union([${[byKey, ...nested.map(discriminatedUnionExpr)].join(', ')}])`
}

const isOpenRecord = (node) =>
  node &&
  typeof node === 'object' &&
  node.type === 'object' &&
  node.additionalProperties === true &&
  !node.properties

/** The wire's parser override: unions, open records, then the card generator's `$ref` rule. */
export const wireParserOverride = (node) => {
  if (node && typeof node === 'object' && Array.isArray(node.oneOf) && node.discriminator) {
    return discriminatedUnionExpr(node)
  }
  if (isOpenRecord(node)) return 'z.record(z.string(), z.unknown())'
  return refParserOverride(node)
}

/** The whole `wire-v2.generated.ts` module, as text. Pure — no file system. */
export function buildWireSchemaModule(root) {
  const defs = root.$defs ?? {}
  const clientBound = defClosure(defs, CLIENT_ROOT)
  const declarations = topologicallyOrderedDefNames(root).map((defName) => {
    const def = clientBound.has(defName) ? defs[defName] : tolerateUnknownKeys(defs[defName])
    const zodExpr = jsonSchemaToZod(def, {
      module: false,
      parserOverride: wireParserOverride,
    })
      // An open model's extra fields (a source's lane, a ledger entry's docs)
      // belong to their own contract: `unknown`, so nothing reads them unchecked.
      .replaceAll('.catchall(z.any())', '.catchall(z.unknown())')
    if (zodExpr.includes('z.any()')) {
      throw new Error(`${defName} would generate z.any(); give the field a type in wire_v2.py`)
    }
    return `export const ${exportName(defName)} = ${zodExpr}`
  })
  const banner =
    '// AUTO-GENERATED from shared/wire/v2.schema.json — do not edit; run `npm run generate:wire`'
  return `${banner}

import { z } from 'zod'

${declarations.join('\n\n')}
`
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
// scripts -> ui -> frontends -> repo root
export const schemaPath = resolve(scriptDir, '../../../shared/wire/v2.schema.json')
export const outPath = resolve(scriptDir, '../src/adapters/api/wire-v2.generated.ts')

// Importing this module (the spec does) must not write the generated file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = JSON.parse(readFileSync(schemaPath, 'utf-8'))
  writeFileSync(outPath, buildWireSchemaModule(root), { encoding: 'utf-8' })
  console.log(`Wrote the chat wire v2 Zod schema to ${outPath}`)
}
