/**
 * First-boot provisioning of the platform default model.
 *
 * `platform_model_defaults` (migration 0026) is created empty, and an empty
 * middle layer means resolution falls through to the workflow YAML `model_name`
 * (see `getEffectiveModelOverrides`). So until a platform owner visited
 * Platform → Models, the fleet ran on a literal in a config file: a model nobody
 * had declared as a decision, invisible in the admin surface and absent from the
 * audit trail. This module closes that by writing the defaults once, on boot.
 *
 * ## Why this is not a SQL migration
 *
 * The obvious shape — seed the rows in a `drizzle` migration — is wrong here,
 * and dangerously so. A platform default replaces the model id and NOTHING else:
 * `override_model` (src/aiq_agent/common/model_overrides.py) deliberately leaves
 * `base_url` and `api_key` alone, so that an override can never re-point traffic
 * at another provider. A migration runs on every deployment regardless of which
 * `BACKEND_CONFIG` that deployment loaded, and the repo ships configs pointing at
 * Kimi (`config_grid_oib.yml`) and NVIDIA (`config_web_default_llamaindex.yml`)
 * as well as OpenRouter. Seeding an OpenRouter id there sends an unknown model
 * to that provider on every request — and the admin UI cannot repair it, because
 * its save path only accepts ids the OpenRouter catalog knows.
 *
 * Running in the application instead buys the four things SQL cannot do:
 *
 *   1. **Ask what the deployment actually runs.** `GET /v1/config/llm-defaults`
 *      reports the base URL per LLM; anything not on the platform catalog's
 *      provider is left alone, which is the correct reading of "no row" — that
 *      deployment's own config decides.
 *   2. **Validate.** The same live-catalog capability check the admin PUT
 *      refuses to skip, rather than a claim in a SQL comment.
 *   3. **Record `model_snapshot`.** Including `_zdr.safe`, so ZDR tenants
 *      inheriting this default can be warned — the control 0026 built and a
 *      migration would have left NULL.
 *   4. **Invalidate the cache and write an audit event**, so the change reaches
 *      traffic at once and appears in the trail like any other fleet-wide model
 *      decision.
 *
 * ## Safety properties
 *
 * - Runs only when the table is entirely EMPTY. A deployment that has any
 *   default of its own has an opinion, and this must not add rows underneath it.
 * - Holds a transaction-scoped Postgres advisory lock across the empty-table
 *   check and the write, so concurrent replicas cannot race and the lock cannot
 *   outlive the connection that took it.
 * - Never throws into boot: every failure logs and leaves the table empty, which
 *   is exactly the pre-existing behaviour (fall through to the YAML).
 * - Skips `ingest_vlm` unless the ingestion VLM is itself on the platform
 *   provider. That group has its own credential plane (`AIQ_VLM_BASE_URL`) whose
 *   shipped default routes to NVIDIA; seeding it would make an operator's
 *   `AIQ_VLM_MODEL` dead config and break captioning against that endpoint.
 */

import 'server-only'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { recordAuditEvent } from '@/lib/audit/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { AGENT_GROUPS } from './agent-groups'
import { getWorkflowLlmBaseUrls, type LlmBaseUrls } from './backend-defaults'
import { baseModelId, fetchModelCatalog, fetchZdrModelIds, validateOverrides } from './openrouter'
import { getPlatformModelDefaults, savePlatformModelDefaults } from './platform-defaults'

/**
 * The model a fresh deployment starts on. Deliberately a constant and not an
 * env var: it is the *initial* value of an admin-owned setting, not a knob. Move
 * the fleet under Platform → Models, which validates, audits and takes effect
 * without a redeploy.
 */
export const BOOTSTRAP_DEFAULT_MODEL = 'openai/gpt-5.6-luna'

/** Actor recorded on bootstrapped rows — not a WorkOS user id. */
export const BOOTSTRAP_ACTOR = 'system:bootstrap'

const BOOTSTRAP_NOTE = 'Initial platform default, set on first boot — change under Platform → Models.'

/**
 * Advisory-lock key. Arbitrary but fixed.
 *
 * Taken with `pg_try_advisory_xact_lock` inside the write transaction, NOT the
 * session-scoped `pg_try_advisory_lock`. `getDb()` is a pool: a session lock
 * taken on one pooled connection and released on another is never released at
 * all, and every later boot would then see the lock held and skip provisioning —
 * silently, forever. A transaction lock is released by COMMIT/ROLLBACK on the
 * connection that took it, so it cannot leak, and holding it for the write means
 * two replicas booting together still cannot both provision.
 */
const BOOTSTRAP_LOCK_KEY = 4_130_026

/**
 * Hosts whose model ids the platform OpenRouter catalog can validate.
 *
 * Exact host or a DOT-delimited subdomain — a bare `endsWith` would also accept
 * `notopenrouter.ai`, which is a different operator's domain, and qualifying it
 * would write OpenRouter model ids into a deployment pointed at it.
 */
function targetsPlatformProvider(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/**
 * Which groups this deployment may safely be given a platform default for.
 *
 * A group qualifies only when EVERY workflow LLM behind it is on the platform
 * provider — `deep_research` spans three, and re-pointing it while one of them
 * talks to another endpoint would break that one. A group whose LLMs are all
 * unknown to the backend (absent from the report) does not qualify: "unknown
 * endpoint" must never be read as "OpenRouter".
 */
export function groupsEligibleForBootstrap(baseUrls: LlmBaseUrls): string[] {
  return AGENT_GROUPS.filter((group) => {
    const refs = group.configLlmRefs.filter((ref) => ref in baseUrls)
    if (refs.length !== group.configLlmRefs.length) return false
    return refs.every((ref) => targetsPlatformProvider(baseUrls[ref]))
  }).map((group) => group.id)
}

/**
 * Provision the platform defaults if this deployment has none. Safe to call on
 * every boot; returns the groups actually written (empty when it did nothing).
 */
export async function bootstrapPlatformModelDefaults(): Promise<string[]> {
  // A process with no database configured is not a broken deployment — it is
  // local dev, the screenshot harness, or a build step. Reporting that as a
  // failure on every boot trains people to ignore the log line that matters.
  if (!process.env.GRID_APP_DATABASE_URL) {
    console.debug('[Model Config] Skipping default bootstrap: no application database configured')
    return []
  }
  try {
    return await runBootstrap()
  } catch (error) {
    // Model configuration must never take the app down. An empty table is the
    // pre-existing, working state: the workflow config stays in charge.
    console.error('[Model Config] Platform default bootstrap failed:', error)
    return []
  }
}

async function runBootstrap(): Promise<string[]> {
  // Cheap pre-check before touching the database: the steady state is "already
  // set", and this read is cached.
  if (Object.keys(await getPlatformModelDefaults()).length > 0) return []

  // Everything that can be decided WITHOUT the database is decided first, so the
  // transaction below (which holds the advisory lock) covers only the guard and
  // the write and never waits on a network call.

  // What does this deployment actually run? A failure here is NOT "assume
  // OpenRouter" — an unreachable backend leaves the table empty and the workflow
  // config in charge, the same state as before this ran.
  let baseUrls: LlmBaseUrls
  try {
    baseUrls = await getWorkflowLlmBaseUrls()
  } catch (error) {
    console.warn(
      '[Model Config] Skipping default bootstrap: could not read the backend workflow config:',
      error
    )
    return []
  }

  const eligible = groupsEligibleForBootstrap(baseUrls)
  const skipped = AGENT_GROUPS.map((group) => group.id).filter((id) => !eligible.includes(id))
  if (eligible.length === 0) {
    // The expected path on a Kimi/NVIDIA deployment. Not an error: those
    // deployments are correctly governed by their own workflow config.
    console.warn(
      '[Model Config] Skipping default bootstrap: no agent group runs on the platform model provider'
    )
    return []
  }
  if (skipped.length > 0) {
    console.warn(
      `[Model Config] Bootstrapping platform defaults for ${eligible.join(', ')}; leaving ${skipped.join(', ')} on the deployment's own configuration`
    )
  }

  const defaults = Object.fromEntries(eligible.map((id) => [id, BOOTSTRAP_DEFAULT_MODEL]))

  // Same validation the admin PUT refuses to skip. A catalog outage must not
  // pin the fleet to an unvalidated id, so it aborts rather than writing.
  let catalog
  try {
    catalog = await fetchModelCatalog()
  } catch (error) {
    console.warn('[Model Config] Skipping default bootstrap: model catalog unavailable:', error)
    return []
  }
  const validation = validateOverrides(catalog, defaults, true)
  if (!validation.ok) {
    console.error(
      `[Model Config] Skipping default bootstrap: ${BOOTSTRAP_DEFAULT_MODEL} failed validation:`,
      validation.errors
    )
    return []
  }

  // Best-effort, like the admin path: a missing ZDR listing records `null`
  // ("unknown") rather than blocking, but is never silently recorded as safe.
  let zdrModelIds: Set<string> | null = null
  try {
    zdrModelIds = await fetchZdrModelIds()
  } catch (error) {
    console.warn('[Model Config] Could not resolve the ZDR model listing during bootstrap:', error)
  }
  const modelSnapshot = Object.fromEntries(
    Object.entries(validation.snapshot).map(([group, model]) => [
      group,
      { ...model, _zdr: { safe: zdrModelIds ? zdrModelIds.has(baseModelId(model.id)) : null } },
    ])
  )

  // One transaction, one connection: take the lock, re-check that the table is
  // still empty, and write — so a second replica cannot slip between the check
  // and the write, and the lock is released by COMMIT/ROLLBACK either way.
  const written = await getDb().transaction(async (tx) => {
    const lockRows = Array.from(
      await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}) AS locked`
      )
    )
    if (!lockRows[0]?.locked) {
      console.warn('[Model Config] Skipping default bootstrap: another replica holds the lock')
      return []
    }

    // Re-read under the lock — the replica that held it may have just written.
    const countRows = Array.from(
      await tx.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM platform_model_defaults`
      )
    )
    if (Number(countRows[0]?.count ?? 0) > 0) return []

    await savePlatformModelDefaults(
      {
        defaults,
        modelSnapshot,
        note: BOOTSTRAP_NOTE,
        actorUserId: BOOTSTRAP_ACTOR,
        actorEmail: null,
      },
      tx
    )
    return eligible
  })

  if (written.length === 0) return []

  // A fleet-wide model decision belongs in the trail whoever made it. Failing
  // to audit must not un-write the defaults, so this is deliberately after the
  // commit and swallowed — but loudly.
  try {
    const platformOrgId = await getPlatformOrganizationId()
    if (platformOrgId) {
      await recordAuditEvent({
        organizationId: platformOrgId,
        actor: { userId: BOOTSTRAP_ACTOR, email: null },
        action: 'platform.model_defaults.bootstrapped',
        targetType: 'platform_model_defaults',
        targetId: 'platform',
        metadata: defaults,
      })
    } else {
      console.error(
        '[Model Config] Bootstrapped fleet defaults without an audit event: the platform organization did not resolve'
      )
    }
  } catch (error) {
    console.error('[Model Config] Could not audit the platform default bootstrap:', error)
  }

  console.warn(
    `[Model Config] Bootstrapped platform default ${BOOTSTRAP_DEFAULT_MODEL} for: ${written.join(', ')}`
  )
  return written
}
