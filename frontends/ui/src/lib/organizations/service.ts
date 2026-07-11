/**
 * Organization data service.
 *
 * Bridges the two sources of org truth:
 *   - WorkOS  — identity, domains, members, invitations (fetched live).
 *   - Grid DB — the `organizations` row holding Grid-specific settings.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getWorkOS } from '@/lib/workos/client'
import { getDb } from '@/lib/db'
import { getCached, invalidateCached } from '@/lib/cache'
import { organizations, type Organization } from '@/lib/db/schema'
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
export async function getOrganizationOverview(organizationId: string): Promise<OrganizationOverview> {
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

/**
 * Active members of an org (first page, admin pickers). WorkOS is the source
 * of truth; capped at PAGE_LIMIT like the overview counts.
 */
export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
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

function toSettings(row: Organization | undefined): OrgSettings {
  return {
    displayName: row?.displayName ?? null,
    defaultLocale: isLocale(row?.defaultLocale) ? row.defaultLocale : defaultLocale,
    settings: (row?.settings as Record<string, unknown> | undefined) ?? {},
  }
}

/** Read Grid settings for an org (defaults when no row exists yet). */
export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.workosOrganizationId, organizationId))
    .limit(1)
  return toSettings(row)
}

export interface OrgSettingsPatch {
  displayName?: string | null
  defaultLocale?: Locale
  settings?: Record<string, unknown>
}

/** Upsert Grid settings for an org, merging the `settings` bag. */
export async function updateOrgSettings(
  organizationId: string,
  patch: OrgSettingsPatch,
): Promise<OrgSettings> {
  const db = getDb()
  const current = await getOrgSettings(organizationId)

  const next: OrgSettings = {
    displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    defaultLocale: patch.defaultLocale ?? current.defaultLocale,
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
  }

  await db
    .insert(organizations)
    .values({
      workosOrganizationId: organizationId,
      displayName: next.displayName,
      defaultLocale: next.defaultLocale,
      settings: next.settings,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: organizations.workosOrganizationId,
      set: {
        displayName: next.displayName,
        defaultLocale: next.defaultLocale,
        settings: next.settings,
        updatedAt: new Date(),
      },
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
export async function isWebSearchEnabledForOrg(organizationId: string | null | undefined): Promise<boolean> {
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

/**
 * Update the caller's org settings and record the audit trail. The coarse
 * gate (`org:settings:manage`) is enforced at the route via `apiRoute`'s
 * `options.permission`.
 */
export async function saveOrgSettings(
  session: AuthorizedSession,
  patch: OrgSettingsPatch,
  request: Request,
): Promise<OrgSettings> {
  const settings = await updateOrgSettings(session.organizationId, patch)
  await invalidateCached(webSearchCacheKey(session.organizationId))
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
