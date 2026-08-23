/**
 * Reconcile GRID's WorkOS environment identity — or report the drift.
 *
 * `provision:authz` makes WorkOS agree with the authorization catalog; this
 * script does the same for the pieces around it that used to be dashboard
 * steps: the platform organization, the owner's membership and role, AuthKit
 * web origins, the observability Connect application, and feature-flag
 * targeting. Runbook: `docs/deployment/workos-provisioning.md`.
 *
 *   Usage:
 *     WORKOS_API_KEY=sk_… npm run provision:workos-env          # check (read-only)
 *     WORKOS_API_KEY=sk_… npm run provision:workos-env -- --apply
 *
 * `--check` is the default and never writes. Run it in CI.
 *
 * ## Desired state comes from the environment
 *
 *   GRID_PLATFORM_ORG_EXTERNAL_ID   platform org external id (default grid-platform)
 *   GRID_PLATFORM_OWNER_EMAIL       owner to seat in the platform org (unset = skip)
 *   WORKOS_DESIRED_REDIRECT_URIS    desired AuthKit redirect URIs (comma-separated)
 *   WORKOS_DESIRED_CORS_ORIGINS     desired AuthKit CORS origins (comma-separated)
 *   WORKOS_CONNECT_APP_NAME         observability Connect app name (default GRID Observability)
 *   WORKOS_CONNECT_REDIRECT_URIS    its sign-in callback URIs (comma-separated)
 *   WORKOS_FLAG_TARGETS_JSON        {"<flag-slug>": ["org_id", …]} targeting plan
 *
 * Unset sections are skipped cleanly — a check with none set only verifies the
 * platform organization and reports which flags from the registry are missing.
 *
 * ## Deliberate limits
 *
 * - Resource types have no SDK binding; they stay a dashboard step. A missing
 *   one surfaces in `provision:authz` as a failed permission create naming it.
 * - Flag CREATION has no SDK binding (`listFeatureFlags` exists, create does
 *   not), so missing registry flags are reported as MANUAL, never attempted.
 * - Flag targeting is ADDITIVE: this script adds missing targets but never
 *   removes one — silently untargeting an org would switch a feature off for
 *   it, so removal stays a human decision.
 * - Extras (origins present in WorkOS but not in the desired lists) are
 *   REPORTED, not deleted. Pass `--prune` together with `--apply` to remove
 *   them; without that flag the check stays safe to run against an
 *   environment shared with local-development origins.
 * - The Connect application's scopes (the `platform:organizations:view`
 *   permission under Scopes) are assigned in the dashboard — the SDK's
 *   `scopes` field carries OAuth scopes, not permission assignments.
 */

import { NotFoundException, WorkOS } from '@workos-inc/node'

import { FEATURE_FLAGS } from '../src/lib/authz/feature-flags'
import { diffSets, parseFlagTargets, splitList } from './provision-workos-env-plan'

const PLATFORM_ORG_EXTERNAL_ID = process.env.GRID_PLATFORM_ORG_EXTERNAL_ID ?? 'grid-platform'
const PLATFORM_ROLE_SLUG = 'org-platform-owner'

const WORKOS_API_BASE = 'https://api.workos.com'

const apply = process.argv.includes('--apply')
const prune = process.argv.includes('--prune')
const apiKey = process.env.WORKOS_API_KEY
if (!apiKey) {
  console.error('WORKOS_API_KEY is required.')
  process.exit(2)
}

const workos = new WorkOS(apiKey)
const drift: string[] = []
const applied: string[] = []
/** Steps nothing here can perform — printed as the closing summary. */
const manual: string[] = ['create resource types Organization → Project → Skill in the dashboard (no SDK binding)']

const note = (message: string) => console.log(`  ${message}`)

async function listAll<T>(
  page: (after?: string) => Promise<{ data: T[]; listMetadata?: { after?: string | null } }>
): Promise<T[]> {
  const all: T[] = []
  let after: string | undefined
  do {
    const result = await page(after)
    all.push(...result.data)
    after = result.listMetadata?.after ?? undefined
  } while (after)
  return all
}

/**
 * Raw REST call for the two User Management settings the SDK does not bind
 * (redirect URIs / CORS origins). Responses are validated defensively — the
 * payload shape is not covered by the installed typings.
 */
async function workosRest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; detail: string }> {
  let response: Response
  try {
    response = await fetch(`${WORKOS_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, status: 0, detail: String(error) }
  }
  if (!response.ok) {
    return { ok: false, status: response.status, detail: await response.text() }
  }
  return { ok: true, payload: await response.json().catch(() => null) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The rows of a list response. The API may return a bare array or a paged
 * `{ data: […] }` envelope depending on version — accept both.
 */
function normalizeRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isPlainObject)
  if (isPlainObject(payload) && Array.isArray(payload['data'])) {
    return (payload['data'] as unknown[]).filter(isPlainObject)
  }
  return []
}

async function reconcilePlatformOrg(): Promise<string | null> {
  console.log('\nPlatform organization')
  try {
    const org = await workos.organizations.getOrganizationByExternalId(PLATFORM_ORG_EXTERNAL_ID)
    note(`ok       ${PLATFORM_ORG_EXTERNAL_ID} (${org.id})`)
    return org.id
  } catch (error) {
    if (!(error instanceof NotFoundException)) throw error
  }
  if (!apply) {
    drift.push(`platform organization "${PLATFORM_ORG_EXTERNAL_ID}" not found`)
    note(`MISSING  ${PLATFORM_ORG_EXTERNAL_ID}`)
    return null
  }
  try {
    const org = await workos.organizations.createOrganization({
      name: 'GRID Platform',
      externalId: PLATFORM_ORG_EXTERNAL_ID,
    })
    applied.push(`created platform organization "${PLATFORM_ORG_EXTERNAL_ID}" (${org.id})`)
    note(`created  ${PLATFORM_ORG_EXTERNAL_ID} (${org.id})`)
    return org.id
  } catch (error) {
    drift.push(`could not create platform organization: ${String(error)}`)
    note(`FAILED   create — ${String(error)}`)
    return null
  }
}

async function reconcileOwner(platformOrgId: string | null): Promise<void> {
  console.log('\nPlatform owner')
  const email = process.env.GRID_PLATFORM_OWNER_EMAIL
  if (!email || !email.trim()) {
    note(`skipped  GRID_PLATFORM_OWNER_EMAIL is unset`)
    return
  }
  if (!platformOrgId) {
    drift.push('owner cannot be seated — the platform organization does not exist')
    note('MISSING  platform organization')
    return
  }

  const users = await listAll((after) => workos.userManagement.listUsers({ email, after }))
  const user = users.find((candidate) => candidate.email.toLowerCase() === email.trim().toLowerCase())
  if (!user) {
    manual.push(`invite user ${email} (not found in this environment)`)
    drift.push(`owner user "${email}" not found`)
    note(`MISSING  user ${email}`)
    return
  }

  const memberships = await listAll((after) =>
    workos.userManagement.listOrganizationMemberships({ userId: user.id, organizationId: platformOrgId, after })
  )
  const membership = memberships.find((candidate) => candidate.organizationId === platformOrgId)

  if (!membership) {
    if (!apply) {
      drift.push(`${email} has no membership in the platform organization`)
      note(`MISSING  membership for ${email}`)
      return
    }
    await workos.userManagement.createOrganizationMembership({
      organizationId: platformOrgId,
      userId: user.id,
    })
    applied.push(`created platform-org membership for ${email}`)
    note(`created  membership for ${email}`)
  }

  // Re-read through the membership we found or just created: role checks need
  // the roles array either way.
  const current =
    membership ??
    (
      await listAll((after) =>
        workos.userManagement.listOrganizationMemberships({ userId: user.id, organizationId: platformOrgId, after })
      )
    ).find((candidate) => candidate.organizationId === platformOrgId)
  if (!current) {
    drift.push(`membership for ${email} could not be read back after creation`)
    return
  }

  const hasRole =
    current.roles?.some((role) => role.slug === PLATFORM_ROLE_SLUG) ||
    current.role?.slug === PLATFORM_ROLE_SLUG
  if (hasRole) {
    note(`ok       ${PLATFORM_ROLE_SLUG} on ${email}`)
    return
  }
  if (!apply) {
    drift.push(`${email} holds no ${PLATFORM_ROLE_SLUG} role`)
    note(`MISSING  role ${PLATFORM_ROLE_SLUG}`)
    return
  }
  try {
    await workos.authorization.assignRole({
      organizationMembershipId: current.id,
      roleSlug: PLATFORM_ROLE_SLUG,
      resourceId: platformOrgId,
    })
    applied.push(`assigned ${PLATFORM_ROLE_SLUG} to ${email}`)
    note(`assigned ${PLATFORM_ROLE_SLUG} to ${email}`)
  } catch (error) {
    drift.push(`could not assign ${PLATFORM_ROLE_SLUG}: ${String(error)}`)
    note(`FAILED   role assignment — ${String(error)}`)
  }
}

/**
 * One AuthKit web-origin list (redirect URIs or CORS origins) via raw REST —
 * the Node SDK binds neither. Extras are report-only unless --apply --prune.
 */
async function reconcileWebOrigins(
  label: string,
  kind: 'redirect_uris' | 'cors_origins',
  desired: string[]
): Promise<void> {
  console.log(`\n${label}`)
  if (desired.length === 0) {
    note('skipped  desired list is unset')
    return
  }

  const listing = await workosRest('GET', `/user_management/${kind}`)
  if (!listing.ok) {
    drift.push(`could not read ${kind}: HTTP ${listing.status} ${listing.detail}`)
    note(`FAILED   read — HTTP ${listing.status}`)
    return
  }

  const valueField = kind === 'redirect_uris' ? 'url' : 'origin'
  const rows = normalizeRows(listing.payload)
  const current: string[] = []
  for (const row of rows) {
    if (typeof row[valueField] === 'string') current.push(row[valueField] as string)
  }
  const idByValue = new Map(
    rows.filter((row) => typeof row[valueField] === 'string').map((row) => [row[valueField] as string, row['id']])
  )

  const { missing, extra } = diffSets(desired, current)
  for (const value of desired) {
    if (missing.includes(value)) {
      if (!apply) {
        drift.push(`${kind} missing in WorkOS: ${value}`)
        note(`MISSING  ${value}`)
        continue
      }
      const written = await workosRest('POST', `/user_management/${kind}`, { [valueField]: value })
      if (!written.ok) {
        drift.push(`could not add ${kind} ${value}: HTTP ${written.status} ${written.detail}`)
        note(`FAILED   ${value} — HTTP ${written.status}`)
        continue
      }
      applied.push(`added ${kind} ${value}`)
      note(`added    ${value}`)
    }
  }
  for (const value of extra) {
    const canPrune = apply && prune && typeof idByValue.get(value) === 'string'
    if (!canPrune) {
      drift.push(`extra ${kind} in WorkOS: ${value}`)
      note(`EXTRA    ${value}${apply && !prune ? ' (pass --prune to remove)' : ''}`)
      continue
    }
    const removed = await workosRest('DELETE', `/user_management/${kind}/${String(idByValue.get(value))}`)
    if (!removed.ok) {
      drift.push(`could not remove extra ${kind} ${value}: HTTP ${removed.status} ${removed.detail}`)
      note(`FAILED   remove ${value} — HTTP ${removed.status}`)
      continue
    }
    applied.push(`removed extra ${kind} ${value}`)
    note(`removed  ${value}`)
  }
}

async function connectAppName(): Promise<string> {
  return process.env.WORKOS_CONNECT_APP_NAME?.trim() || 'GRID Observability'
}

/** Mint a client secret and print the credential pair exactly once. */
async function mintConnectSecret(appName: string, id: string, clientId: string): Promise<void> {
  try {
    const secret = await workos.connect.createApplicationClientSecret({ id })
    applied.push(`minted client secret for "${appName}"`)
    console.log()
    console.log('  ── NEW CLIENT CREDENTIALS — shown ONCE, store them now ──')
    console.log(`    client id:     ${clientId}`)
    console.log(`    client secret: ${secret.secret}`)
    console.log('    Store via:')
    console.log('      pulumi config set        grid-oib:otelOidcClientId     <client id>')
    console.log("      pulumi config set --secret grid-oib:otelOidcClientSecret '<client secret>'")
    console.log('    (issuer is your AuthKit domain, e.g. https://<tenant>.authkit.app)')
    console.log()
  } catch (error) {
    drift.push(
      `Connect application "${appName}" exists but has no usable client secret — fix the cause and re-run --apply`
    )
    note(`FAILED   secret mint for "${appName}" — ${String(error)}`)
  }
}

/**
 * An existing application may predate a failed first run that created it but
 * could not mint its secret — retry the mint on every check/apply pass.
 */
async function ensureConnectSecret(appName: string, id: string, clientId: string): Promise<void> {
  let secrets
  try {
    secrets = await workos.connect.listApplicationClientSecrets({ id })
  } catch (error) {
    drift.push(`could not list client secrets of "${appName}": ${String(error)}`)
    note(`FAILED   secret check — ${String(error)}`)
    return
  }
  if (secrets.length > 0) return
  if (!apply) {
    drift.push(`Connect application "${appName}" has no client secret`)
    note(`MISSING  client secret for "${appName}" — re-run with --apply to mint one`)
    return
  }
  await mintConnectSecret(appName, id, clientId)
}

async function reconcileConnectApp(): Promise<void> {
  console.log('\nObservability Connect application')
  const appName = await connectAppName()
  const uris = splitList(process.env.WORKOS_CONNECT_REDIRECT_URIS)
  if (uris.length === 0) {
    note('skipped  WORKOS_CONNECT_REDIRECT_URIS is unset')
    return
  }

  const apps = await listAll((after) => workos.connect.listApplications({ after }))
  const existing = apps.find((app) => app.name === appName)

  if (existing) {
    if (existing.applicationType !== 'oauth') {
      drift.push(`Connect application "${appName}" exists but is a ${existing.applicationType} app`)
      note(`DRIFT    ${appName} — wrong application type`)
      return
    }
    const current = existing.redirectUris.map((entry) => entry.uri)
    const { missing, extra } = diffSets(uris, current)
    if (missing.length === 0 && extra.length === 0) {
      note(`ok       ${appName} (${existing.clientId})`)
      await ensureConnectSecret(appName, existing.id, existing.clientId)
      return
    }
    const detail = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      extra.length ? `extra ${extra.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    if (!apply) {
      drift.push(`Connect application "${appName}" redirect URIs differ — ${detail}`)
      note(`DRIFT    ${appName} — ${detail}`)
      return
    }
    try {
      await workos.connect.updateApplication({
        id: existing.id,
        redirectUris: uris.map((uri) => ({ uri })),
      })
      applied.push(`updated Connect application "${appName}" (${detail})`)
      note(`updated  ${appName} — ${detail}`)
    } catch (error) {
      drift.push(`could not update Connect application "${appName}": ${String(error)}`)
      note(`FAILED   update — ${String(error)}`)
    }
    return
  }

  if (!apply) {
    drift.push(`Connect application "${appName}" not found`)
    note(`MISSING  ${appName}`)
    return
  }

  // Creation and secret minting are separately retryable: a failure in the
  // second must not lose the first — the next run takes the existing-app
  // path above and mints the missing secret there.
  let createdId: string | undefined
  try {
    // Confidential client: PKCE off. Scopes are NOT passed — the SDK field
    // takes OAuth scopes, while the dashboard's "assign permission" step is
    // what grants platform:organizations:view (kept MANUAL below).
    const created = await workos.connect.createApplication({
      name: appName,
      applicationType: 'oauth',
      description: 'GRID observability stack (Aspire dashboard) sign-in.',
      isFirstParty: true,
      usesPkce: false,
      redirectUris: uris.map((uri) => ({ uri })),
    })
    createdId = created.id
    applied.push(`created Connect application "${appName}"`)
    note(`created  ${appName} (${created.clientId})`)
    await mintConnectSecret(appName, created.id, created.clientId)
  } catch (error) {
    drift.push(`could not create Connect application "${appName}": ${String(error)}`)
    note(`FAILED   create — ${String(error)}`)
  }
}

async function reconcileFlags(): Promise<void> {
  console.log('\nFeature flags')

  const existingSlugs = new Set(
    (await listAll((after) => workos.featureFlags.listFeatureFlags({ after }))).map((flag) => flag.slug)
  )
  for (const slug of Object.values(FEATURE_FLAGS)) {
    if (existingSlugs.has(slug)) {
      note(`ok       ${slug}`)
      continue
    }
    // No SDK binding for flag creation — reporting is all this script can do.
    manual.push(`create feature flag "${slug}" in the dashboard (creation has no SDK binding)`)
    drift.push(`feature flag missing in WorkOS: ${slug}`)
    note(`MISSING  ${slug} — MANUAL (dashboard-only creation)`)
  }
  for (const slug of existingSlugs) {
    if (!Object.values(FEATURE_FLAGS).includes(slug as (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS])) {
      note(`UNKNOWN  ${slug} — in WorkOS, absent from the registry`)
    }
  }

  const targets = parseFlagTargets(process.env.WORKOS_FLAG_TARGETS_JSON)
  if (!targets.ok) {
    drift.push(`WORKOS_FLAG_TARGETS_JSON invalid — ${targets.error}`)
    note(`FAILED   parse WORKOS_FLAG_TARGETS_JSON — ${targets.error}`)
    return
  }
  if (targets.entries.length === 0) {
    note('skipped  WORKOS_FLAG_TARGETS_JSON is unset')
    return
  }

  // One read per targeted org, cached: the SDK cannot enumerate a flag's
  // targets directly, but it can list what an org sees.
  const orgFlags = new Map<string, Set<string>>()
  const flagsForOrg = async (orgId: string): Promise<Set<string>> => {
    const cached = orgFlags.get(orgId)
    if (cached) return cached
    const slugs = new Set(
      (
        await listAll((after) =>
          workos.featureFlags.listOrganizationFeatureFlags({ organizationId: orgId, after })
        )
      ).map((flag) => flag.slug)
    )
    orgFlags.set(orgId, slugs)
    return slugs
  }

  for (const { slug, orgIds } of targets.entries) {
    if (!existingSlugs.has(slug)) {
      note(`skipped  ${slug} — flag does not exist yet (see MANUAL above)`)
      continue
    }
    for (const orgId of orgIds) {
      if ((await flagsForOrg(orgId)).has(slug)) {
        note(`ok       ${slug} → ${orgId}`)
        continue
      }
      if (!apply) {
        drift.push(`flag "${slug}" is not targeted at organization ${orgId}`)
        note(`MISSING  ${slug} → ${orgId}`)
        continue
      }
      try {
        await workos.featureFlags.addFlagTarget({ slug, targetId: orgId })
        applied.push(`targeted flag "${slug}" at ${orgId}`)
        note(`targeted ${slug} → ${orgId}`)
      } catch (error) {
        drift.push(`could not target "${slug}" at ${orgId}: ${String(error)}`)
        note(`FAILED   ${slug} → ${orgId} — ${String(error)}`)
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`GRID environment identity → WorkOS (${apply ? 'APPLY' : 'CHECK — read-only'})`)

  const platformOrgId = await reconcilePlatformOrg()
  await reconcileOwner(platformOrgId)
  await reconcileWebOrigins('AuthKit redirect URIs', 'redirect_uris', splitList(process.env.WORKOS_DESIRED_REDIRECT_URIS))
  await reconcileWebOrigins('AuthKit CORS origins', 'cors_origins', splitList(process.env.WORKOS_DESIRED_CORS_ORIGINS))
  await reconcileConnectApp()
  await reconcileFlags()

  if (apply) {
    console.log(`\nApplied ${applied.length} change(s).`)
    for (const change of applied) console.log(`  - ${change}`)
  }

  // Controls no WorkOS API can set or verify — reported on EVERY run so a
  // clean reconcile never reads as "fully configured".
  manual.push(
    'create FGA resource types organization/project/skill if absent (dashboard-only)',
    'toggle AuthKit "Allow sign-ups" OFF (dashboard-only)',
    'confirm multipleRolesEnabled matches environment policy (dashboard-only)',
    'arrange customer-managed KEK with WorkOS support (enterprise tenants only)',
    `verify the "${connectAppName()}" Connect application holds platform:organizations:view under Scopes`,
  )

  console.log('\nRemaining MANUAL steps:')
  if (manual.length === 0) console.log('  (none)')
  for (const item of manual) console.log(`  - ${item}`)

  if (drift.length === 0) {
    console.log('\nWorkOS matches the desired environment.')
    return
  }

  console.error(`\n${drift.length} drift finding(s):`)
  for (const finding of drift) console.error(`  - ${finding}`)
  console.error(
    apply
      ? '\nSome changes could not be applied — see above.'
      : '\nRun with --apply to reconcile (resource types and flag creation stay manual).'
  )
  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
