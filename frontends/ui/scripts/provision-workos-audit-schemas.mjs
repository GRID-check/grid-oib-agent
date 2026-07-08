/**
 * Provision GRID's Audit Log actions/schemas in a WorkOS environment.
 *
 * WorkOS validates emitted audit events against per-action schemas; this
 * registers every action the app emits (see src/lib/audit/service.ts).
 * Creating a schema also creates the action when it doesn't exist yet, and
 * re-running simply adds an identical schema version — safe to run anytime.
 *
 * Usage:  WORKOS_API_KEY=sk_... npm run provision:audit-schemas
 * (Run once per environment — Staging and, before go-live, Production.
 *  Documented in docs/deployment/workos-provisioning.md.)
 */

import { WorkOS } from '@workos-inc/node'

// Example metadata values — the SDK infers {type: string|number|boolean}.
const SCHEMAS = [
  {
    action: 'org.created',
    targets: [{ type: 'organization' }],
    metadata: { name: 'Example Org' },
  },
  {
    action: 'org.settings.updated',
    targets: [{ type: 'organization' }],
    metadata: { fields: 'displayName,defaultLocale' },
  },
  {
    action: 'budget.policy.set',
    targets: [{ type: 'budget_policy' }],
    metadata: { scope: 'organization', subjectId: 'user_x', dailyLimitEur: 10, monthlyLimitEur: 100 },
  },
  {
    action: 'budget.policy.cleared',
    targets: [{ type: 'budget_policy' }],
    metadata: { scope: 'member', subjectId: 'user_x' },
  },
  {
    action: 'model_config.version.activated',
    targets: [{ type: 'model_config_version' }],
    metadata: {
      intent: 'openai/gpt-5-mini',
      clarifier: 'openai/gpt-5-mini',
      shallow_research: 'openai/gpt-5-mini',
      deep_research: 'openai/gpt-5-mini',
      deep_research_router: 'openai/gpt-5-mini',
      memory_reflection: 'openai/gpt-5-mini',
      reset: false,
      rollback: false,
    },
  },
  {
    action: 'compliance.hold.created',
    targets: [{ type: 'legal_hold' }],
    metadata: { entityType: 'project', entityId: 'uuid' },
  },
  {
    action: 'compliance.hold.released',
    targets: [{ type: 'legal_hold' }],
    metadata: { entityType: 'project', entityId: 'uuid' },
  },
  {
    action: 'platform.access.break_glass',
    targets: [{ type: 'platform' }],
    metadata: { activeOrganizationId: 'org_x' },
  },
]

const apiKey = process.env.WORKOS_API_KEY
if (!apiKey) {
  console.error('WORKOS_API_KEY is required (the target environment’s secret key).')
  process.exit(1)
}

const workos = new WorkOS(apiKey)
let failures = 0
for (const schema of SCHEMAS) {
  try {
    const created = await workos.auditLogs.createSchema(schema)
    console.log(`✔ ${schema.action} (schema v${created.version})`)
  } catch (error) {
    failures += 1
    console.error(`✘ ${schema.action}:`, error.message ?? error)
  }
}
process.exit(failures === 0 ? 0 : 1)
