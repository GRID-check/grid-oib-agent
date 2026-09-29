/**
 * Telling the platform owners that a member sent feedback.
 *
 * The announcement is an inbox item of type `feedback.submitted`, one per
 * owner, written into the PLATFORM organization. The owners read it through
 * the inbox's platform lane from whichever organization they are working in,
 * and the type's registry entry says it also goes out by email the moment a
 * sender exists (`@/lib/inbox/delivery`). This module therefore knows nothing
 * about channels: it records what happened and who it is for, once.
 *
 * ## Recipients come from a permission, not a role name
 *
 * The same rule the storage alert follows: active members of the platform
 * organization whose role holds {@link FEEDBACK_TRIAGE_PERMISSION}, the
 * permission the triage page needs to change a report. Those are the people
 * who can act on it. Support holds the read half and sees the reports on the
 * page, but is not paged for each one.
 *
 * Break-glass owners (`GRID_PLATFORM_OWNER_EMAILS`) are not members of the
 * platform organization and are therefore not addressed; the triage page
 * still shows them every report.
 *
 * ## Fail-open, and why that is safe here
 *
 * The report is already stored when this runs, and the triage page lists it
 * whatever happens next. A WorkOS hiccup resolving the roster must not turn a
 * member's "thank you" into an error, so failures are logged and swallowed.
 */

import 'server-only'
import { findRoleSpec } from '@/lib/authz/catalog'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { listOrganizationMembersWithRoles } from '@/lib/organizations/service'

/** The inbox type this module emits. */
export const FEEDBACK_INBOX_TYPE = 'feedback.submitted' as const

/** Who is told: whoever may triage. */
export const FEEDBACK_TRIAGE_PERMISSION = PLATFORM_PERMISSIONS.settingsManage

/** The longest excerpt stored on the row; the read path caps display at 500. */
const EXCERPT_MAX = 500

/**
 * Active platform-organization members whose role holds the triage permission.
 *
 * A role this build does not know is not assumed to hold it: guessing in the
 * permissive direction would send tenants' reports to whoever holds a custom
 * role in the platform organization.
 */
export async function findFeedbackRecipients(platformOrganizationId: string): Promise<string[]> {
  const members = await listOrganizationMembersWithRoles(platformOrganizationId)
  return members
    .filter((member) => member.status === 'active')
    .filter((member) => {
      const spec = member.roleSlug ? findRoleSpec(member.roleSlug) : null
      return spec ? spec.permissions.includes(FEEDBACK_TRIAGE_PERMISSION) : false
    })
    .map((member) => member.id)
}

/** The inbox rows for one report, one per recipient. Pure; exported for tests. */
export function feedbackEmissions(
  report: Pick<ProductFeedback, 'id' | 'kind' | 'message' | 'userId' | 'userName' | 'userEmail'>,
  organizationName: string | null,
  platformOrganizationId: string,
  recipients: readonly string[]
): InboxEmission[] {
  const groupKey = inboxGroupKey(FEEDBACK_INBOX_TYPE, 'product_feedback', report.id)
  const message = report.message.trim()
  return recipients.map((recipientUserId) => ({
    organizationId: platformOrganizationId,
    recipientUserId,
    type: FEEDBACK_INBOX_TYPE,
    resourceType: 'product_feedback',
    resourceId: report.id,
    actorUserId: report.userId,
    groupKey,
    payload: {
      // The organization the report came from — the row's body names it.
      subject: organizationName ?? undefined,
      excerpt: message.length > EXCERPT_MAX ? `${message.slice(0, EXCERPT_MAX)}…` : message,
      // The reporter lives in another organization, which the owner's
      // directory cannot resolve, so the name travels with the row.
      actorName: report.userName ?? report.userEmail ?? undefined,
      kind: report.kind,
    },
  }))
}

export type FeedbackAnnouncement =
  | { status: 'announced'; recipients: number }
  | { status: 'no-platform-organization' }
  | { status: 'no-recipients' }
  | { status: 'failed' }

/** Announce one stored report to the platform owners. Never throws. */
export async function announceProductFeedback(
  report: ProductFeedback,
  organizationName: string | null
): Promise<FeedbackAnnouncement> {
  try {
    const platformOrganizationId = await getPlatformOrganizationId()
    if (!platformOrganizationId) {
      console.warn(
        `[product-feedback] report ${report.id} stored, but no platform organization is provisioned — nobody was notified`
      )
      return { status: 'no-platform-organization' }
    }
    const recipients = await findFeedbackRecipients(platformOrganizationId)
    if (recipients.length === 0) {
      console.warn(
        `[product-feedback] report ${report.id} stored, but no platform member holds "${FEEDBACK_TRIAGE_PERMISSION}" — nobody was notified`
      )
      return { status: 'no-recipients' }
    }
    // The rows belong to the platform organization, so they are written as it:
    // the table's WITH CHECK refuses a row addressed to any other tenant.
    await withTenant({ organizationId: platformOrganizationId }, () =>
      emitInboxItems(feedbackEmissions(report, organizationName, platformOrganizationId, recipients))
    )
    return { status: 'announced', recipients: recipients.length }
  } catch (error) {
    console.error(`[product-feedback] announcing report ${report.id} failed:`, error)
    return { status: 'failed' }
  }
}
