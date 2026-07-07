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
import { organizations, type Organization } from '@/lib/db/schema'
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
