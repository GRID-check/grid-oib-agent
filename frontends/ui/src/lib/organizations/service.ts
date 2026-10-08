/**
 * Organization data service.
 *
 * Bridges the two sources of org truth:
 *   - WorkOS  — identity, domains, members, invitations (fetched live).
 *   - Grid DB — the `organizations` row holding Grid-specific settings.
 */

import 'server-only'
import { findOrganization, upsertOrganization } from './repository'
import { getWorkOS } from '@/lib/workos/client'
import { getCached, invalidateCached } from '@/lib/cache'
import { invalidateBackendModelConfig } from '@/lib/model-config/backend-key'
import { DEDICATED_ROUTE_SETTINGS, PLATFORM_OWNED_SETTINGS, type Organization } from '@/lib/db/schema'
import { BadRequestError, ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { isOrgFeatureEnabled, WEB_SEARCH_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { defaultLocale, isLocale, type Locale } from '@/i18n/config'

export interface OrganizationOverview {
  id: string
  name: string
  domains: string[]
  createdAt: string
  /** Active member count (first page; `memberCountCapped` marks a `+`). */
  memberCount: number
  memberCountCapped: boolean
  pendingInviteCount: number
}

/** Grid-side settings for an org, with defaults applied. */
export interface OrgSettings {
  displayName: string | null
  defaultLocale: Locale
  settings: Record<string, unknown>
}

const PAGE_LIMIT = 100

/** Live org overview from WorkOS. Individual sub-calls fail soft to 0/empty. */
export async function getOrganizationOverview(
  organizationId: string
): Promise<OrganizationOverview> {
  const workos = getWorkOS()

  const org = await workos.organizations.getOrganization(organizationId)

  let memberCount = 0
  let memberCountCapped = false
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId,
      statuses: ['active'],
      limit: PAGE_LIMIT,
    })
    memberCount = memberships.data.length
    memberCountCapped = Boolean(memberships.listMetadata?.after)
  } catch {
    // Non-fatal — the widget still shows the authoritative roster.
  }

  let pendingInviteCount = 0
  try {
    const invitations = await workos.userManagement.listInvitations({
      organizationId,
      limit: PAGE_LIMIT,
    })
    pendingInviteCount = invitations.data.filter((i) => i.state === 'pending').length
  } catch {
    // Non-fatal.
  }

  return {
    id: org.id,
    name: org.name,
    domains: org.domains?.map((d) => d.domain) ?? [],
    createdAt: org.createdAt,
    memberCount,
    memberCountCapped,
    pendingInviteCount,
  }
}

export interface OrganizationMember {
  /** WorkOS user id (`user_…`) — the budget-policy subject id. */
  id: string
  email: string
  name: string | null
}

/** A member plus the role they hold, for the Access tab's directory. */
export interface OrganizationMemberWithRole extends OrganizationMember {
  /** WorkOS role slug for this membership, or null when none is resolvable. */
  roleSlug: string | null
  /** Membership status (`active`, `pending`, …) straight from WorkOS. */
  status: string
}

/**
 * Active members of an org (first page, admin pickers). WorkOS is the source
 * of truth; capped at PAGE_LIMIT like the overview counts.
 */
export async function listOrganizationMembers(
  organizationId: string
): Promise<OrganizationMember[]> {
  const workos = getWorkOS()
  const users = await workos.userManagement.listUsers({ organizationId, limit: PAGE_LIMIT })
  return users.data
    .map((user) => ({
      id: user.id,
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email))
}

/**
 * The member directory behind the Access tab: every membership in the
 * organization with the role it carries.
 *
 * Deliberately built from `listOrganizationMemberships` rather than
 * `listUsers` — the membership is what holds the role, and it is also what
 * WorkOS authorizes against. Identities are then resolved in ONE batched call
 * instead of per-member, so a 200-person org costs two round-trips.
 *
 * Best-effort on the identity half: if the user lookup fails, members still
 * appear with their id and role rather than the page failing outright.
 */
export async function listOrganizationMembersWithRoles(
  organizationId: string
): Promise<OrganizationMemberWithRole[]> {
  const workos = getWorkOS()
  const memberships = await workos.userManagement.listOrganizationMemberships({
    organizationId,
    limit: PAGE_LIMIT,
  })

  const identities = new Map<string, { email: string; name: string | null }>()
  try {
    const users = await workos.userManagement.listUsers({ organizationId, limit: PAGE_LIMIT })
    for (const user of users.data) {
      identities.set(user.id, {
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      })
    }
  } catch {
    // Non-fatal: the roster is still useful without display names.
  }

  return memberships.data
    .map((membership) => {
      const identity = identities.get(membership.userId)
      return {
        id: membership.userId,
        email: identity?.email ?? membership.userId,
        name: identity?.name ?? null,
        roleSlug: membership.role?.slug ?? null,
        status: String(membership.status),
      }
    })
    .sort((a, b) => a.email.localeCompare(b.email))
}

function toSettings(row: Organization | undefined): OrgSettings {
  return {
    displayName: row?.displayName ?? null,
    defaultLocale: isLocale(row?.defaultLocale) ? row.defaultLocale : defaultLocale,
    settings: (row?.settings as Record<string, unknown> | undefined) ?? {},
  }
}

/** Read Grid settings for an org (defaults when no row exists yet). */
export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  return toSettings((await findOrganization(organizationId)) ?? undefined)
}

const ORG_NAME_CACHE_TTL_MS = 300_000
const orgNameCacheKey = (organizationId: string): string => `orgname:${organizationId}`

/**
 * The org's human name, for chrome that has to say which organization the
 * reader is acting in.
 *
 * Prefers the Grid-side `displayName` (a local row) and only falls back to
 * WorkOS, because this is called from a layout on a navigation path — a
 * WorkOS round-trip per render would put an identity API in front of every
 * page. The fallback is cached for five minutes: an org rename is rare and
 * five minutes of staleness on a label costs nothing, where an uncached miss
 * would be paid by every reader on every load.
 *
 * Fails soft to `null`. This resolves a LABEL; chrome must still render if the
 * identity service is down, so callers treat null as "omit the line" rather
 * than as an error.
 */
export async function getOrganizationDisplayName(
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null
  return getCached(orgNameCacheKey(organizationId), ORG_NAME_CACHE_TTL_MS, async () => {
    try {
      const { displayName } = await getOrgSettings(organizationId)
      if (displayName) return displayName
      const org = await getWorkOS().organizations.getOrganization(organizationId)
      return org.name || null
    } catch {
      return null
    }
  })
}

export interface OrgSettingsPatch {
  displayName?: string | null
  defaultLocale?: Locale
  settings?: Record<string, unknown>
}

/**
 * Upsert Grid settings for an org, merging the `settings` bag.
 *
 * REFUSES platform-owned keys (see `PLATFORM_OWNED_SETTINGS`). Every tenant-facing
 * write reaches the bag through here, so this is the one place the refusal has to
 * live — putting it in the settings route would leave the next route to remember
 * it. Without the guard, a generic `PUT /api/organization/settings` would let a
 * tenant set `storageQuotaBytes` and raise its own quota.
 *
 * Platform-tier writers call {@link updatePlatformOwnedOrgSettings} instead. That
 * is a distinct exported name rather than a boolean argument on this function
 * precisely so `grep` finds every platform write, and so nothing reaches the
 * bypass by passing `true`.
 */
export async function updateOrgSettings(
  organizationId: string,
  patch: OrgSettingsPatch
): Promise<OrgSettings> {
  const keys = Object.keys(patch.settings ?? {})
  const offending = keys.filter((key) => (PLATFORM_OWNED_SETTINGS as readonly string[]).includes(key))
  if (offending.length > 0) {
    throw new ForbiddenError(
      `${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} set by the platform ` +
        'operator, not by the organization.'
    )
  }
  // Own keys only: `in` would also match `constructor` and `toString`.
  const dedicated = keys.filter((key): key is keyof typeof DEDICATED_ROUTE_SETTINGS =>
    Object.prototype.hasOwnProperty.call(DEDICATED_ROUTE_SETTINGS, key)
  )
  if (dedicated.length > 0) {
    throw new BadRequestError(
      dedicated.map((key) => `${key} cannot be changed here: ${DEDICATED_ROUTE_SETTINGS[key]}.`).join(' ')
    )
  }
  return writeOrgSettings(organizationId, patch)
}

/**
 * Upsert Grid settings INCLUDING platform-owned keys. PLATFORM TIER ONLY.
 *
 * Named for what it permits so that the audit question — "what can write the
 * quota?" — is answerable by searching for one identifier, and it ENFORCES what
 * the name claims.
 *
 * The session is required and the check runs here. Reachability from an
 * authorized route is a fact about the call graph at one moment, defended by
 * nothing, and the bypass this opens is exactly the one `updateOrgSettings`
 * closes; so `PLATFORM_OWNED_SETTINGS` has no unguarded writer anywhere.
 *
 * The route-level platform gate stays where it is. Checking twice costs a
 * cached predicate and means neither layer is load-bearing alone.
 */
export async function updatePlatformOwnedOrgSettings(
  session: GridSession | null,
  organizationId: string,
  patch: OrgSettingsPatch
): Promise<OrgSettings> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage)
  return writeOrgSettings(organizationId, patch)
}

/**
 * Write ONE key the generic save refuses (`DEDICATED_ROUTE_SETTINGS`), for the
 * dedicated service that owns it. The key must be declared there: this is not
 * a second generic writer, it is the door each dedicated route walks through,
 * and a key nobody declared has no route that validates it.
 */
export async function writeDedicatedOrgSetting(
  organizationId: string,
  key: keyof typeof DEDICATED_ROUTE_SETTINGS,
  value: unknown
): Promise<OrgSettings> {
  if (!Object.prototype.hasOwnProperty.call(DEDICATED_ROUTE_SETTINGS, key)) {
    throw new BadRequestError(`${String(key)} is not a dedicated setting`)
  }
  return writeOrgSettings(organizationId, { settings: { [key]: value } })
}

/** The merge itself. Private: every caller goes through one of the exported writers above. */
async function writeOrgSettings(
  organizationId: string,
  patch: OrgSettingsPatch
): Promise<OrgSettings> {
  const current = await getOrgSettings(organizationId)
  const next: OrgSettings = {
    displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    defaultLocale: patch.defaultLocale ?? current.defaultLocale,
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
  }

  await upsertOrganization({
    organizationId,
    displayName: next.displayName,
    defaultLocale: next.defaultLocale,
    settings: next.settings,
  })

  return next
}

const WEB_SEARCH_CACHE_TTL_MS = 30_000
const webSearchCacheKey = (organizationId: string): string => `websearch:${organizationId}`

/**
 * Effective web-search availability for an org (ADR-0022) — read on every
 * WS upgrade and by the `/api/v1/data_sources` proxy, so it is cached
 * briefly (write-invalidated by `saveOrgSettings`). Two layers:
 *
 *  - Tenant layer: `settings.webSearchEnabled` (default TRUE — web search is
 *    a core capability until an org admin turns it off).
 *  - Platform layer: the WorkOS `web-search` flag, participating only when
 *    `GRID_ENFORCE_FEATURE_FLAGS=true` (the flag must be provisioned first;
 *    see docs/deployment/workos-provisioning.md).
 *
 * No org (anonymous deployments) = enabled.
 */
export async function isWebSearchEnabledForOrg(
  organizationId: string | null | undefined
): Promise<boolean> {
  if (!organizationId) return true
  return getCached(webSearchCacheKey(organizationId), WEB_SEARCH_CACHE_TTL_MS, async () => {
    const { settings } = await getOrgSettings(organizationId)
    if (settings.webSearchEnabled === false) return false
    const enforceFlags = (process.env.GRID_ENFORCE_FEATURE_FLAGS ?? '').toLowerCase() === 'true'
    if (enforceFlags) {
      return isOrgFeatureEnabled(WEB_SEARCH_FLAG, organizationId, false)
    }
    return true
  })
}

const ZDR_ONLY_CACHE_TTL_MS = 30_000
/**
 * `:v2` keeps this key clear of entries written under the earlier reading of an
 * absent setting (off), which a replica still on that reading may have cached as
 * `false` for an org that never chose.
 */
const zdrOnlyCacheKey = (organizationId: string): string => `zdronly:v2:${organizationId}`

/**
 * Whether zero data retention is in force for the org (ADR-0014 privacy
 * control). **On unless the org explicitly opted out**: only a stored boolean
 * `false` in `settings.zdrOnly` turns it off, so an org that never touched the
 * switch, a malformed value, and no org at all are all ZDR. Independent of the
 * `model-configuration` feature flag, which gates the admin surface and never
 * the default.
 *
 * Read by the model-config picker/save path (to filter the OpenRouter catalog)
 * and by the Python backend via `/api/internal/model-overrides` (to add
 * `provider.zdr` to every OpenRouter request). Cached briefly, write-
 * invalidated by `setOrgZdrOnly`.
 */
export async function isZdrOnlyForOrg(organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return true
  return getCached(zdrOnlyCacheKey(organizationId), ZDR_ONLY_CACHE_TTL_MS, async () => {
    const { settings } = await getOrgSettings(organizationId)
    return isZdrOnlySetting(settings.zdrOnly)
  })
}

/** The one reading of the stored value: anything but an explicit `false` is ZDR. */
export function isZdrOnlySetting(value: unknown): boolean {
  return value !== false
}

/**
 * Toggle the org's zero-data-retention policy and record the audit trail with
 * the value before and after. The only writer of `zdrOnly`: the generic
 * settings save refuses the key (`DEDICATED_ROUTE_SETTINGS`), so the gate at
 * the dedicated route (`org:models:manage` + the model-configuration flag) is
 * the gate. Writes past `updateOrgSettings` for exactly that reason.
 */
export async function setOrgZdrOnly(
  session: AuthorizedSession,
  enabled: boolean,
  request: Request
): Promise<{ zdrOnly: boolean; previous: boolean }> {
  const before = await getOrgSettings(session.organizationId)
  const previous = isZdrOnlySetting(before.settings.zdrOnly)
  await writeOrgSettings(session.organizationId, { settings: { zdrOnly: enabled } })
  await invalidateCached(zdrOnlyCacheKey(session.organizationId))
  // The backend folds ZDR into the same cached record as the model overrides.
  await invalidateBackendModelConfig(session.organizationId)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'model_config.zdr.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { zdrOnly: String(enabled), previous: String(previous) },
    request,
  })
  return { zdrOnly: enabled, previous }
}

/**
 * Update the caller's org settings and record the audit trail. The coarse
 * gate (`org:settings:manage`) is enforced at the route via `apiRoute`'s
 * `options.permission`.
 */
export async function saveOrgSettings(
  session: AuthorizedSession,
  patch: OrgSettingsPatch,
  request: Request
): Promise<OrgSettings> {
  // Read before writing: the backend's shared record carries web search, so the
  // cross-tier delete fires solely when that field actually moves, and the
  // audit names only what changed. (`zdrOnly` cannot move here: the merge
  // refuses it.)
  const before = await getOrgSettings(session.organizationId)
  const settings = await updateOrgSettings(session.organizationId, patch)
  await invalidateCached(webSearchCacheKey(session.organizationId))
  if (before.settings.webSearchEnabled !== settings.settings.webSearchEnabled) {
    await invalidateBackendModelConfig(session.organizationId)
  }
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.settings.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { fields: changedSettingsFields(before, settings).join(',') },
    request,
  })
  return settings
}

/**
 * What a save changed, as `displayName`, `defaultLocale` and `settings.<key>`.
 * The bag is listed per key: `settings` alone would tell the trail nothing about
 * which switch moved.
 */
export function changedSettingsFields(before: OrgSettings, after: OrgSettings): string[] {
  const fields: string[] = []
  if (before.displayName !== after.displayName) fields.push('displayName')
  if (before.defaultLocale !== after.defaultLocale) fields.push('defaultLocale')
  const keys = new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])
  for (const key of [...keys].sort()) {
    if (JSON.stringify(before.settings[key]) !== JSON.stringify(after.settings[key])) fields.push(`settings.${key}`)
  }
  return fields
}
