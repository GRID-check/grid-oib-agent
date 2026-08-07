/**
 * What an inbox item points at, and whether the reader can still reach it.
 *
 * ## Why this module exists
 *
 * `inbox_items.resource_type` used to be typed `ShareableResourceType`, and the
 * read path went straight to `describeResource()` + `resolveResourceAccess()`.
 * Both are the SHARING registry: they answer "who has been granted what on this
 * object", and `describeResource` THROWS for a type it does not know. That was
 * fine while every notification was about a conversation, and wrong the moment
 * one was about the tenant itself — an organization is not shareable, must not
 * become shareable (adding it to `SHAREABLE_RESOURCE_TYPES` would make an org a
 * thing you can hand somebody a grant on), and has no owner/visibility/grant
 * story at all.
 *
 * So the inbox gets its own target registry, one level above sharing:
 *
 *   - it is exhaustive over `InboxTargetType`, so a new target kind cannot ship
 *     without a deep link AND an access resolver — the same discipline
 *     `SHAREABLE_REGISTRY` applies to shareable types;
 *   - the `conversation` entry DELEGATES to the sharing registry rather than
 *     re-deriving anything, so shareable resources keep exactly one access
 *     definition;
 *   - `resolve` returns `null` for "unreachable" instead of throwing, because
 *     unreachable is the ordinary answer here (revoked, deleted, another
 *     tenant's) and the row must render redacted rather than take the page down.
 *
 * Nothing in this module is a cast or a special case in the read path: adding
 * `organization` cost one descriptor.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { INBOX_TARGET_TYPES, type InboxItemType, type InboxTargetType } from '@/lib/db/schema'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { describeResource } from '@/lib/sharing/registry'

/** Row-level context a deep link may use. */
export interface InboxTargetLinkContext {
  /** The item's type — an org-scoped alert lands on the page that explains it. */
  itemType: InboxItemType
  /** The exact spot inside the target, when the type has one. */
  anchorId?: string | null
}

/**
 * A target the reader CAN still reach. Existence of this object is the
 * authorization decision; `deepLink` is what the row renders as its href.
 */
export interface InboxTargetAccess {
  deepLink: (context: InboxTargetLinkContext) => string
}

export interface InboxTargetDescriptor {
  readonly type: InboxTargetType
  /**
   * Re-derive access at READ time (spec IB-13) and, if it holds, hand back the
   * link builder. `null` means "redact this row".
   *
   * MUST NOT throw for an unreachable target. The caller swallows throws as
   * unreachable too — redacting is the safe direction — but a descriptor that
   * relies on that turns an ordinary revocation into a logged warning per row.
   */
  readonly resolve: (
    session: AuthorizedSession,
    resourceId: string,
  ) => Promise<InboxTargetAccess | null>
}

/**
 * Where an organization-scoped item lands.
 *
 * Data rather than a `switch`, and per ITEM TYPE rather than per target type,
 * because "your organization" is not a place — the useful destination is the
 * page that explains the alert and offers the thing to do about it. A type with
 * no entry falls back to the organization overview, which is never wrong, only
 * vague.
 */
const ORGANIZATION_DESTINATIONS: Partial<Record<InboxItemType, string>> = {
  'storage.quota_warning': '/app/organization/storage',
}

const conversationTarget: InboxTargetDescriptor = {
  type: 'conversation',
  resolve: async (session, resourceId) => {
    const access = await resolveResourceAccess(session, 'conversation', resourceId)
    // `role: null` is "exists, but you have no access" — as unreachable as a 404.
    if (!access.role) return null
    return {
      deepLink: (context) =>
        describeResource('conversation').deepLink(resourceId, {
          anchorId: context.anchorId ?? undefined,
          projectId: access.container.projectId,
        }),
    }
  },
}

/**
 * The tenant itself — the target of operational alerts (ADR-0042).
 *
 * Access is membership, and membership is already proven: the inbox list is
 * scoped to `session.organizationId` in SQL, so a row from another tenant cannot
 * be returned in the first place. The comparison below is therefore a belt on
 * top of that WHERE clause, not the only strap — it exists so that a row written
 * with the wrong organization id (a bug in an emitter, a bad backfill) renders
 * redacted instead of linking a member into a tenant they do not belong to.
 *
 * There is deliberately no permission check here. The Organization → Storage
 * page is readable by every member by design (ADR-0042: the member whose upload
 * was refused is usually not an admin, and that page is the only thing that
 * explains the refusal), so gating the LINK harder than the page it points at
 * would produce a redacted row in front of a page the reader can simply open.
 * Who the alert is ADDRESSED to is a separate decision, made once at emission
 * time by the recipient resolver — not re-litigated on every render.
 */
const organizationTarget: InboxTargetDescriptor = {
  type: 'organization',
  resolve: async (session, resourceId) => {
    if (resourceId !== session.organizationId) return null
    return {
      deepLink: (context) => ORGANIZATION_DESTINATIONS[context.itemType] ?? '/app/organization',
    }
  },
}

/**
 * Exhaustive over `InboxTargetType` by construction — `tsc` fails if a member of
 * the union has no descriptor.
 */
export const INBOX_TARGET_REGISTRY: Record<InboxTargetType, InboxTargetDescriptor> = {
  conversation: conversationTarget,
  organization: organizationTarget,
}

/**
 * Descriptor lookup that never throws.
 *
 * Unlike `describeResource`, an unknown value here is NOT a programming error:
 * `resource_type` is a `text` column, so a row written by a newer deploy — or
 * read across a rollback — carries a value this build has never heard of. The
 * old code threw for exactly that case and took the whole inbox route with it.
 * An unknown target is simply unreachable, which is what a redacted row means.
 */
export function findInboxTarget(type: string): InboxTargetDescriptor | null {
  return (INBOX_TARGET_TYPES as readonly string[]).includes(type)
    ? INBOX_TARGET_REGISTRY[type as InboxTargetType]
    : null
}
