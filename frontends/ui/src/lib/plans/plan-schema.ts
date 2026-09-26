/**
 * The research-plan wire schemas, as JSON Schema, for the Python tier.
 *
 * The zod schemas in `./plan-types` are the source, `lib/api/zod-json-schema.ts`
 * converts them, and `tests/fixtures/research-plan.schema.json` is the committed
 * artifact both languages read — `src/aiq_agent/common/research_plan.py`
 * validates its models against that file rather than restating the shape.
 * Same arrangement as the run ledger, same regeneration rule:
 * `plan-schema.spec.ts` rewrites the fixture under `UPDATE_FIXTURES=1` and
 * otherwise fails when it is stale.
 */

import { jsonSchemaDocument, type JsonSchemaNode } from '@/lib/api/zod-json-schema'
import { RESEARCH_PLAN_WIRE_SCHEMAS } from './plan-types'

export function researchPlanJsonSchema(): JsonSchemaNode {
  return jsonSchemaDocument(RESEARCH_PLAN_WIRE_SCHEMAS, {
    title: 'Grid research plan wire contract',
    description:
      'Generated from frontends/ui/src/lib/plans/plan-types.ts. Do not edit by hand: ' +
      'plan-schema.spec.ts rewrites this file and fails when it is stale.',
  })
}
