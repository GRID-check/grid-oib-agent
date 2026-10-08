/**
 * The lifecycle wire schemas, as JSON Schema, for the Python tier.
 *
 * ## Why this exists at all
 *
 * The agent's `file_draft` tool has to describe the same request body the
 * internal route parses. Writing a Pydantic model beside the zod one is two
 * hand-written descriptions of one contract, and two lists of one contract drift
 * apart silently: the only symptom is an ERROR log on the side that never
 * throws. So the zod schemas are the
 * source, `lib/api/zod-json-schema.ts` converts them, and
 * `tests/fixtures/document-lifecycle.schema.json` is the committed artifact both
 * languages read.
 *
 * ## Where the converter lives
 *
 * It is in `lib/api/zod-json-schema.ts`, because the run ledger
 * (`lib/runs/run-ledger-schema.ts`) uses it too, and it is not document-specific:
 * it describes zod. `toJsonSchema` is re-exported here so this module stays the
 * one import for everything about the lifecycle's wire contract.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { DOCUMENT_LIFECYCLE_WIRE_SCHEMAS } from './lifecycle-types'

export { toJsonSchema, UnsupportedSchemaNodeError } from '@/lib/api/zod-json-schema'
export type { JsonSchemaNode } from '@/lib/api/zod-json-schema'

/**
 * The whole export, exactly as the fixture holds it.
 *
 * `$defs` keyed by the names in `DOCUMENT_LIFECYCLE_WIRE_SCHEMAS`, so the Python
 * side loads one file and looks a shape up by name rather than by position.
 */
export function documentLifecycleJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(DOCUMENT_LIFECYCLE_WIRE_SCHEMAS, {
    title: 'Grid document lifecycle wire contract',
    description:
      'Generated from frontends/ui/src/lib/documents/lifecycle-types.ts. Do not edit by hand: ' +
      'lifecycle-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
