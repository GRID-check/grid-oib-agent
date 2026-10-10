/**
 * The cross-project lookups' wire schemas, as JSON Schema, for the Python tier
 * (ADR-0055, ADR-0094). Generated from `types.ts` into
 * `tests/fixtures/cross-project.schema.json`, which the agent's tools are
 * tested against (`tests/aiq_agent/tools/cross_project/test_wire_contract.py`),
 * so the two languages read one contract.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { CROSS_PROJECT_WIRE_SCHEMAS } from './types'

/** The whole export, exactly as the fixture holds it; `$defs` keyed by the names in `CROSS_PROJECT_WIRE_SCHEMAS`. */
export function crossProjectJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(CROSS_PROJECT_WIRE_SCHEMAS, {
    title: 'Grid cross-project lookups wire contract',
    description:
      'Generated from frontends/ui/src/lib/cross-project/types.ts. Do not edit by hand: ' +
      'cross-project-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
