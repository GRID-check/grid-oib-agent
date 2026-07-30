/**
 * Organization people directory — names, emails and avatars for the WorkOS users
 * in an organization.
 *
 * Three surfaces need it and none of them should each invent their own lookup:
 * the share roster ("who has access"), the mention picker ("who can I tag"), and
 * multi-author message rendering ("who wrote this"). WorkOS is authoritative for
 * identity and the app keeps no user table (ADR-0007), so this is a cached read
 * of WorkOS rather than a join.
 *
 * **Why cached:** a chat with ten authors would otherwise resolve ten identities
 * per render, and `listUsers` is paginated (10/page by default) so an
 * unpaginated call would silently truncate a larger organization. Precedent for
 * the TTL: membership resolution is cached 10 minutes, feature flags 30 seconds.
 * A name or avatar going 5 minutes stale is invisible; the alternative is a
 * WorkOS round-trip on every message bubble.
 *
 * This module deliberately exposes NO authorization. Being in the directory says
 * nothing about what you can reach — that is `@/lib/sharing/access`.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'

/** A person as the collaboration surfaces need to show them. */
export interface DirectoryPerson {
  userId: string
  email: string | null
  name: string
  profilePictureUrl: string | null
}

const DIRECTORY_TTL_MS = 5 * 60 * 1000

/** Best display name available, falling back through the fields WorkOS may leave empty. */
function displayName(user: {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full || user.email || 'Unknown'
}

/**
 * Every user in an organization, keyed by WorkOS user id.
 *
 * Pages through the whole roster (`autoPagination`) so an organization with more
 * than one page is not silently cut off. Returns an empty map on failure — the
 * callers all degrade to showing ids/initials rather than breaking, because a
 * WorkOS hiccup must not take the chat down.
 */
export async function loadOrganizationDirectory(
  organizationId: string,
): Promise<Map<string, DirectoryPerson>> {
  const people = await getCached(`directory:${organizationId}`, DIRECTORY_TTL_MS, async () => {
    try {
      const workos = getWorkOS()
      const users = await workos.userManagement
        .listUsers({ organizationId })
        .then((page) => page.autoPagination())
      return users.map((user) => ({
        userId: user.id,
        email: user.email ?? null,
        name: displayName(user),
        profilePictureUrl: user.profilePictureUrl ?? null,
      })) satisfies DirectoryPerson[]
    } catch (error) {
      console.warn(`[directory] failed to load organization ${organizationId}:`, error)
      return [] as DirectoryPerson[]
    }
  })

  return new Map(people.map((person) => [person.userId, person]))
}

/**
 * Resolve a subset of ids to people. Unknown ids are simply absent from the
 * result — a deactivated or cross-org id must not fabricate a person.
 */
export async function resolvePeople(
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, DirectoryPerson>> {
  if (userIds.length === 0) return new Map()
  const directory = await loadOrganizationDirectory(organizationId)
  const wanted = new Set(userIds)
  return new Map([...directory].filter(([userId]) => wanted.has(userId)))
}

/** A placeholder for an id the directory cannot resolve, so the UI still renders. */
export function unknownPerson(userId: string): DirectoryPerson {
  return { userId, email: null, name: userId, profilePictureUrl: null }
}
