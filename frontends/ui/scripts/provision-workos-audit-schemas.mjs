/**
 * Reconcile GRID's Audit Log actions/schemas with a WorkOS environment — or
 * report the drift.
 *
 * WorkOS validates every emitted event against the schema registered for its
 * action, and rejects the event outright when there is none. The registry
 * (`src/lib/audit/schemas.mjs`) is the single source of truth this script
 * applies: the app derives `AUDIT_ACTIONS` from the same keys, so the code and
 * the identity provider cannot drift apart the way they did for the nine
 * actions behind issues #255/#256.
 *
 *   Usage:
 *     WORKOS_API_KEY=sk_… npm run provision:audit-schemas            # check (read-only)
 *     WORKOS_API_KEY=sk_… npm run provision:audit-schemas -- --apply
 *
 * `--check` is the default and never writes, matching `provision:authz`.
 *
 * This RECONCILES rather than re-creates. The previous version called
 * `createSchema` unconditionally and its own header admitted that re-running
 * "simply adds an identical schema version" — harmless once by hand, but it now
 * runs from a Kubernetes Job on every deploy (`deploy/pulumi/src/app/
 * audit-schemas-job.ts`), which would mint a new version of all ~30 schemas
 * forever. So: read what the environment already has, and write only what is
 * missing or genuinely different.
 *
 * ## What this script does NOT do
 *
 * `@workos-inc/node` exposes no way to enumerate the environment's actions
 * (the REST API has `GET /audit_logs/actions`; the SDK binds only
 * `listSchemas(action)`), so the read is one call per action we own and an
 * action WorkOS knows about but the app never emits stays invisible here. That
 * direction is harmless — an unused action rejects nothing.
 */

import { NotFoundException, WorkOS } from '@workos-inc/node'

import { AUDIT_SCHEMAS } from '../src/lib/audit/schemas.mjs'

const apply = process.argv.includes('--apply')
const apiKey = process.env.WORKOS_API_KEY
if (!apiKey) {
  console.error('WORKOS_API_KEY is required (the target environment’s secret key).')
  process.exit(2)
}

const workos = new WorkOS(apiKey)
const drift = []
const applied = []

const note = (message) => console.log(`  ${message}`)

/**
 * The live schema for an action, or null when the action has none yet. A
 * never-emitted action has no schema *collection* either, so the API 404s —
 * that is "missing", not a failure.
 */
async function currentSchema(action) {
  let versions
  try {
    versions = await (await workos.auditLogs.listSchemas(action)).autoPagination()
  } catch (error) {
    if (error instanceof NotFoundException) return null
    throw error
  }
  // WorkOS keeps every version; only the newest one validates incoming events.
  return versions.reduce((latest, schema) => (!latest || schema.version > latest.version ? schema : latest), null)
}

/** Comparable rendering of the parts we own, so equal schemas look equal. */
const renderTargets = (targets) => targets.map((target) => target.type).sort().join(', ')
const renderMetadata = (metadata) =>
  Object.entries(metadata ?? {})
    .map(([key, type]) => `${key}:${type}`)
    .sort()
    .join(', ')

/**
 * Why only these two fields: target metadata and the actor schema are things
 * this app never sets, so comparing them would report drift a re-apply cannot
 * fix — and churn a new version on every deploy, the exact failure mode this
 * rewrite exists to remove.
 */
function describeDifference(live, wanted) {
  const differences = []
  if (renderTargets(live.targets) !== renderTargets(wanted.targets)) {
    differences.push(`targets [${renderTargets(live.targets)}] → [${renderTargets(wanted.targets)}]`)
  }
  if (renderMetadata(live.metadata) !== renderMetadata(wanted.metadata)) {
    differences.push(`metadata {${renderMetadata(live.metadata)}} → {${renderMetadata(wanted.metadata)}}`)
  }
  return differences.join('; ')
}

async function reconcileSchemas() {
  console.log('\nAudit Log schemas')
  for (const [action, wanted] of Object.entries(AUDIT_SCHEMAS)) {
    let live
    try {
      live = await currentSchema(action)
    } catch (error) {
      drift.push(`could not read ${action}: ${String(error)}`)
      note(`FAILED   ${action} — ${String(error)}`)
      continue
    }

    if (live) {
      const difference = describeDifference(live, wanted)
      if (!difference) {
        note(`ok       ${action} (v${live.version})`)
        continue
      }
      if (!apply) {
        drift.push(`schema for ${action} differs — ${difference}`)
        note(`DRIFT    ${action} (v${live.version}) — ${difference}`)
        continue
      }
    } else if (!apply) {
      drift.push(`no schema in WorkOS for ${action} — events for it are REJECTED`)
      note(`MISSING  ${action}`)
      continue
    }

    try {
      const created = await workos.auditLogs.createSchema({ action, ...wanted })
      applied.push(
        live
          ? `updated ${action} (v${live.version} → v${created.version})`
          : `created ${action} (v${created.version})`,
      )
      note(`${live ? 'updated' : 'created'}  ${action} (v${created.version})`)
    } catch (error) {
      drift.push(`could not write ${action}: ${String(error)}`)
      note(`FAILED   ${action} — ${String(error)}`)
    }
  }
}

async function main() {
  const count = Object.keys(AUDIT_SCHEMAS).length
  console.log(`GRID audit registry (${count} actions) → WorkOS (${apply ? 'APPLY' : 'CHECK — read-only'})`)

  await reconcileSchemas()

  if (apply) {
    console.log(`\nApplied ${applied.length} change(s).`)
    for (const change of applied) console.log(`  - ${change}`)
  }

  if (drift.length === 0) {
    console.log('\nWorkOS matches the audit registry.')
    return
  }

  console.error(`\n${drift.length} drift finding(s):`)
  for (const finding of drift) console.error(`  - ${finding}`)
  console.error(
    apply
      ? '\nSome changes could not be applied — see above.'
      : '\nRun with --apply to reconcile.',
  )
  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
