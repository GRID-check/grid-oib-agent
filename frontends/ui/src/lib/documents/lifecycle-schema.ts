/**
 * The lifecycle wire schemas, as JSON Schema, for the Python tier.
 *
 * ## Why this exists at all
 *
 * The agent's `file_draft` tool has to describe the same request body the
 * internal route parses. Writing a Pydantic model beside the zod one is two
 * hand-written descriptions of one contract, and the repo already has the
 * cautionary tale: `AUDIT_ACTIONS` and the provisioning script's `SCHEMAS` array
 * were two lists meant to be one and drifted by nine actions, with the only
 * symptom an ERROR log on the side that never throws. So the zod schemas are the
 * source, `lib/api/zod-json-schema.ts` converts them, and
 * `tests/fixtures/document-lifecycle.schema.json` is the committed artifact both
 * languages read.
 *
 * ## Why the converter is no longer in this file
 *
 * It was written here and has a second caller now — the run ledger
 * (`lib/runs/run-ledger-schema.ts`) — so it moved to `lib/api/zod-json-schema.ts`
 * rather than being copied. Nothing about it was ever document-specific; it
 * describes zod. `toJsonSchema` is re-exported here so this module stays the one
 * import for everything about the lifecycle's wire contract.
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
