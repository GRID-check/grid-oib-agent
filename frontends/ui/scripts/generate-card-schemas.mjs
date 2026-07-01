// SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the frontend Zod schema (`src/shared/cards/generated.ts`) from the
 * canonical Grid card JSON Schema (`shared/cards/schemas.json`).
 *
 * The JSON Schema is itself generated from the Pydantic models, making the
 * Pydantic models the single source of truth across backend and frontend.
 *
 * Run with: `npm run generate:cards`
 */

import { jsonSchemaToZod } from 'json-schema-to-zod'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// scripts -> ui -> frontends -> repo root
const schemaPath = resolve(scriptDir, '../../../shared/cards/schemas.json')
const outPath = resolve(scriptDir, '../src/shared/cards/generated.ts')

const root = JSON.parse(readFileSync(schemaPath, 'utf-8'))
const defs = root.$defs ?? root.definitions ?? {}

/** Convert a `$def` name (e.g. `SummaryCard`) to its exported const name. */
const exportName = (defName) => `${defName[0].toLowerCase()}${defName.slice(1)}Schema`

/** Resolve a local `$ref` like `#/$defs/SummaryCard` to its def name. */
const refToDefName = (ref) => ref.split('/').pop()

// Preserve the discriminated-union member order from the schema's `oneOf`.
const orderedDefNames = (root.oneOf ?? []).map((entry) => refToDefName(entry.$ref))
for (const name of Object.keys(defs)) {
  if (!orderedDefNames.includes(name)) orderedDefNames.push(name)
}

const discriminator = root.discriminator?.propertyName ?? 'type'

const perTypeDeclarations = orderedDefNames.map((defName) => {
  const zodExpr = jsonSchemaToZod(defs[defName], { module: false })
  return `export const ${exportName(defName)} = ${zodExpr}`
})

const unionMembers = orderedDefNames.map((defName) => exportName(defName)).join(',\n  ')

const banner = [
  '// AUTO-GENERATED from shared/cards/schemas.json — do not edit; run `npm run generate:cards`',
  '// SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.',
  '// SPDX-License-Identifier: Apache-2.0',
].join('\n')

const fileContents = `${banner}

import { z } from 'zod'

${perTypeDeclarations.join('\n\n')}

export const gridCardSchema = z.discriminatedUnion('${discriminator}', [
  ${unionMembers},
])
`

writeFileSync(outPath, fileContents, { encoding: 'utf-8' })
console.log(`Wrote Grid card Zod schema to ${outPath}`)
