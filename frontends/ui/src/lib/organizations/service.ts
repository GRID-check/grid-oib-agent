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
import { PLATFORM_OWNED_SETTINGS, type Organization } from '@/lib/db/schema'
import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { isOrgFeatureEnabled, WEB_SEARCH_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
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
 * it, and the reason this guard exists is that `PUT /api/organization/settings`
 * accepted `storageQuotaBytes` and let a tenant raise its own quota.
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
  const offending = Object.keys(patch.settings ?? {}).filter((key) =>
    (PLATFORM_OWNED_SETTINGS as readonly string[]).includes(key)
  )
  if (offending.length > 0) {
    throw new ForbiddenError(
      `${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} set by the platform ` +
        'operator, not by the organization.'
    )
  }
  return writeOrgSettings(organizationId, patch)
}

/**
 * Upsert Grid settings INCLUDING platform-owned keys. PLATFORM TIER ONLY.
 *
 * Carries no authorization of its own: the callers are reached through
 * `platformApiRoute`, whose `requirePlatformOwner` runs before the handler.
 * Named for what it permits so that the audit question — "what can write the
 * quota?" — is answerable by searching for one identifier.
 */
export async function updatePlatformOwnedOrgSettings(
  organizationId: string,
  patch: OrgSettingsPatch
): Promise<OrgSettings> {
  return writeOrgSettings(organizationId, patch)
}

/** The merge itself. Private: every caller goes through one of the two above. */
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
const zdrOnlyCacheKey = (organizationId: string): string => `zdronly:${organizationId}`

/**
 * Whether the org restricts model selection AND inference to Zero-Data-
 * Retention endpoints (ADR-0014 privacy control). Stored in the org settings
 * JSON (`settings.zdrOnly`, default FALSE), gated by `org:models:manage`.
 *
 * Read by the model-config picker/save path (to filter the OpenRouter catalog)
 * and by the Python backend via `/api/internal/model-overrides` (to add
 * `provider.zdr` to every OpenRouter request). Cached briefly, write-
 * invalidated by `setOrgZdrOnly`/`saveOrgSettings`. No org = disabled.
 */
export async function isZdrOnlyForOrg(organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return false
  return getCached(zdrOnlyCacheKey(organizationId), ZDR_ONLY_CACHE_TTL_MS, async () => {
    const { settings } = await getOrgSettings(organizationId)
    return settings.zdrOnly === true
  })
}

/**
 * Toggle the org's Zero-Data-Retention-only policy and record the audit trail.
 * The gate (`org:models:manage`) is enforced at the route — the same
 * permission that governs the rest of model configuration.
 */
export async function setOrgZdrOnly(
  session: AuthorizedSession,
  enabled: boolean,
  request: Request
): Promise<boolean> {
  await updateOrgSettings(session.organizationId, { settings: { zdrOnly: enabled } })
  await invalidateCached(zdrOnlyCacheKey(session.organizationId))
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'model_config.zdr.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { zdrOnly: String(enabled) },
    request,
  })
  return enabled
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
  const settings = await updateOrgSettings(session.organizationId, patch)
  await invalidateCached(webSearchCacheKey(session.organizationId))
  await invalidateCached(zdrOnlyCacheKey(session.organizationId))
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.settings.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { fields: Object.keys(patch).join(',') },
    request,
  })
  return settings
}
