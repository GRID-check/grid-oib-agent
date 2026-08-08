/**
 * "Your organization is running out of storage" — the alert half of the quota
 * (ADR-0042).
 *
 * The quota already refuses the upload that would cross it. That is correct and
 * useless as a warning: the first person to learn about the limit is whoever
 * happens to upload the file that breaks, mid-task, and the thing they need to
 * do about it (delete documents, or ask the operator for more) is not something
 * they can do in that moment. This module is the part that tells somebody
 * BEFORE the wall.
 *
 * ## Three decisions worth reading before changing anything here
 *
 * **1. It fires once per threshold crossing, not once per check.** The sweep
 * runs on a schedule, so the naive version re-emits every run — and
 * `upsertInboxItems` deliberately REVIVES a row on conflict (count + 1,
 * read/resolved/archived/inert all cleared), because for a mention that is
 * exactly right. For a standing condition it is not: it would re-surface the
 * same warning hourly until somebody freed space, which trains people to ignore
 * the inbox. So the crossed bucket is part of the group key AND the emitter
 * checks for a live row first.
 *
 * **2. Falling back below the threshold RETIRES the alert, deliberately.** When
 * usage drops, the outstanding rows are archived. That is not just tidiness: an
 * archived row is not "live", so the suppression check passes again and a later
 * re-crossing alerts properly. Alerting → recovering → alerting again is a real
 * sequence (a big ingest, a bulk delete, another ingest) and the second alert is
 * as newsworthy as the first. Leaving the old row standing would have swallowed
 * it silently, which is the worst of both behaviours.
 *
 * **3. Recipients are derived from a permission, not from a role name or an
 * owner column.** There is no "responsible for the org" concept in this system,
 * so the closest true statement is "whoever can manage the organization's
 * settings" — `org:settings:manage`. Those are the people who can both delete
 * documents and talk to the operator about the quota, which are the only two
 * ways out.
 */

import 'server-only'
import { findRoleSpec } from '@/lib/authz/catalog'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems } from '@/lib/inbox/service'
import { archiveInboxItemsOfType, findLiveInboxGroupKeys } from '@/lib/inbox/repository'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { withTenant } from '@/lib/db/tenant-context'
import { listOrganizationMembersWithRoles } from '@/lib/organizations/service'
import { aggregateStorageUsageByOrganization } from './repository'
import { getStorageQuotaBytes } from './service'

/** The inbox type this module emits. */
export const STORAGE_ALERT_TYPE = 'storage.quota_warning' as const

/**
 * Who hears about it. `org:settings:manage` rather than a role slug: roles are
 * WorkOS-side configuration and a deployment may rename or add them, whereas the
 * permission is the capability the alert actually presupposes. The stock `admin`
 * role holds it.
 */
export const STORAGE_ALERT_PERMISSION = 'org:settings:manage'

/** Percentage of the quota at which the first warning goes out. */
const DEFAULT_THRESHOLD_PERCENT = 80

/**
 * The escalation ladder, above the configured threshold.
 *
 * Fixed steps rather than "every N percent" so that FULL always gets its own
 * bucket whatever the threshold is set to — "you have run out" is a different
 * message from "you are nearly out", and a computed step can straddle 100%.
 * Entries at or below the threshold are dropped, so a threshold of 95 yields
 * `[95, 100]` and one of 50 yields `[50, 90, 100]`.
 */
const ESCALATION_PERCENTS = [90, 100] as const

/**
 * Configured threshold, clamped to something a percentage can be.
 *
 * A nonsense value falls back to the default rather than disabling the alert:
 * a typo in an env var should not silently switch off the warning that stops a
 * tenant walking into a wall.
 */
export function storageAlertThresholdPercent(
  raw = process.env.GRID_STORAGE_ALERT_THRESHOLD_PERCENT,
): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return DEFAULT_THRESHOLD_PERCENT
  return parsed
}

/** The ladder for a threshold, ascending. */
function bucketsFor(thresholdPercent: number): number[] {
  return [thresholdPercent, ...ESCALATION_PERCENTS.filter((step) => step > thresholdPercent)]
}

/**
 * The highest bucket this usage has crossed, or null when there is nothing to
 * warn about.
 *
 * Null for an unlimited org (no quota, nothing to be a percentage of) and for
 * usage below the threshold. Exported because it is the whole decision and it is
 * worth testing on its own, without a database anywhere near it.
 */
export function crossedBucketPercent(
  usedBytes: number,
  quotaBytes: number | null,
  thresholdPercent = storageAlertThresholdPercent(),
): number | null {
  if (quotaBytes === null || quotaBytes <= 0) return null
  const usedPercent = (usedBytes / quotaBytes) * 100
  const crossed = bucketsFor(thresholdPercent).filter((bucket) => usedPercent >= bucket)
  return crossed.length > 0 ? crossed[crossed.length - 1] : null
}

/**
 * The people to tell.
 *
 * **Known cap:** `listOrganizationMembersWithRoles` returns the FIRST PAGE of
 * memberships (`PAGE_LIMIT = 100` in `@/lib/organizations/service`), and it is
 * not paginated here on purpose — this runs on a schedule for every tenant, and
 * walking every membership of every organization to find the two or three admins
 * would make a housekeeping sweep O(all members of the fleet). In an
 * organization with more than 100 memberships an admin sorted past the first
 * page will not receive the alert. Accepted because the alert only has to reach
 * SOMEONE who can act, and admins are a small set that is well inside the first
 * page in every real tenant; if that ever stops being true, the fix is a
 * membership query filtered by role in WorkOS, not a loop here.
 */
export async function findStorageAlertRecipients(organizationId: string): Promise<string[]> {
  const members = await listOrganizationMembersWithRoles(organizationId)
  return members
    .filter((member) => member.status === 'active')
    .filter((member) => {
      if (!member.roleSlug) return false
      const spec = findRoleSpec(member.roleSlug)
      // A role this build does not know about is not assumed to hold the
      // permission. Guessing in the permissive direction here would mail an
      // organization's storage position to whoever happens to hold a custom role.
      return spec ? spec.permissions.includes(STORAGE_ALERT_PERMISSION) : false
    })
    .map((member) => member.id)
}

export type StorageAlertStatus =
  /** No quota — there is no "full" to warn about. */
  | 'unlimited'
  /** Under the threshold. Any outstanding alert was retired. */
  | 'below-threshold'
  /** Crossed, but every recipient already has a live row for this bucket. */
  | 'suppressed'
  /** Crossed, and nobody in the organization can act on it. */
  | 'no-recipients'
  /** Crossed, and at least one person was told. */
  | 'alerted'

export interface StorageAlertOutcome {
  organizationId: string
  status: StorageAlertStatus
  /** Share of quota in use, rounded — null when unlimited. */
  usedPercent: number | null
  /** The bucket that was crossed, null when none was. */
  bucketPercent: number | null
  /** Recipients newly notified in this run. */
  notified: number
  /** Rows archived: a cleared condition, or a superseded lower bucket. */
  retired: number
}

export interface EvaluateStorageAlertOptions {
  thresholdPercent?: number
  /** Injected in tests; production reads the org's effective quota. */
  quotaBytes?: number | null
}

/**
 * Decide and act for ONE organization.
 *
 * Never throws for a tenant-shaped problem (no quota, no admins, nothing to do)
 * — this runs unattended across every tenant, and one odd organization must not
 * end the sweep for the rest.
 */
export async function evaluateStorageAlert(
  organizationId: string,
  usedBytes: number,
  options: EvaluateStorageAlertOptions = {},
): Promise<StorageAlertOutcome> {
  const thresholdPercent = options.thresholdPercent ?? storageAlertThresholdPercent()
  const quotaBytes =
    options.quotaBytes !== undefined ? options.quotaBytes : await getStorageQuotaBytes(organizationId)

  const usedPercent =
    quotaBytes !== null && quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : null
  const bucketPercent = crossedBucketPercent(usedBytes, quotaBytes, thresholdPercent)

  // Nothing to warn about. Retire whatever is outstanding — both because the
  // statement is no longer true, and because retiring it re-arms the suppression
  // check so a later re-crossing is announced rather than swallowed.
  if (bucketPercent === null) {
    const retired = await archiveInboxItemsOfType(organizationId, STORAGE_ALERT_TYPE)
    return {
      organizationId,
      status: quotaBytes === null || quotaBytes <= 0 ? 'unlimited' : 'below-threshold',
      usedPercent,
      bucketPercent: null,
      notified: 0,
      retired,
    }
  }

  const anchorId = String(bucketPercent)
  // Retire the buckets that are no longer the current one, so an escalation
  // REPLACES its predecessor instead of leaving two rows about one disk. Runs
  // before the suppression probe, which is why it cannot retire the row it is
  // about to check for.
  const retired = await archiveInboxItemsOfType(organizationId, STORAGE_ALERT_TYPE, {
    exceptAnchorId: anchorId,
  })

  const recipients = await findStorageAlertRecipients(organizationId)
  if (recipients.length === 0) {
    // Not an error: an organization can legitimately have no active admin (an
    // invite not yet accepted, a role removed). Logged rather than thrown — the
    // sweep must carry on, and this is the one condition an operator would want
    // to see, because it means a tenant is heading for a wall with nobody home.
    console.warn(
      `[storage-alert] ${organizationId} is at ${usedPercent}% of its storage quota but has no active member holding "${STORAGE_ALERT_PERMISSION}" — nobody was notified`,
    )
    return {
      organizationId,
      status: 'no-recipients',
      usedPercent,
      bucketPercent,
      notified: 0,
      retired,
    }
  }

  const groupKey = inboxGroupKey(STORAGE_ALERT_TYPE, 'organization', organizationId, anchorId)
  const live = await findLiveInboxGroupKeys(
    organizationId,
    recipients.map((recipientUserId) => ({ recipientUserId, groupKey })),
  )

  const emissions: InboxEmission[] = recipients
    .filter((recipientUserId) => !live.has(`${recipientUserId}\n${groupKey}`))
    .map((recipientUserId) => ({
      organizationId,
      recipientUserId,
      type: STORAGE_ALERT_TYPE,
      resourceType: 'organization',
      resourceId: organizationId,
      // The crossed bucket, which is what makes the group key per-crossing.
      anchorId,
      // System-generated: there is no actor, and inventing one ("Grid") would
      // put a fake person's name in the row's title.
      actorUserId: null,
      groupKey,
      payload: {
        // `subject` is the only payload key the row renders, and the copy around
        // it is localised — so this stays a locale-neutral token rather than a
        // server-formatted English sentence.
        subject: `${usedPercent}%`,
        usedBytes,
        quotaBytes,
        usedPercent,
        thresholdPercent,
        bucketPercent,
      },
    }))

  if (emissions.length === 0) {
    return { organizationId, status: 'suppressed', usedPercent, bucketPercent, notified: 0, retired }
  }

  await emitInboxItems(emissions)
  return {
    organizationId,
    status: 'alerted',
    usedPercent,
    bucketPercent,
    notified: emissions.length,
    retired,
  }
}

export interface StorageAlertSweepResult {
  organizationsChecked: number
  alerted: number
  notified: number
  retired: number
  thresholdPercent: number
}

/**
 * Every organization with stored bytes, in one pass.
 *
 * Driven by ONE grouped cross-tenant aggregate rather than a per-org query, for
 * the same reason the platform storage page is: a per-org round trip would make
 * this O(tenants) against the database on every tick.
 *
 * Organizations with no documents are not visited, which is correct — zero bytes
 * cannot cross a threshold — with one consequence worth naming: an org that
 * deletes its LAST document keeps whatever alert it had until it uploads again.
 * Rare, and the row is retired the moment anything is stored, so it is not worth
 * a second full-tenant scan per tick.
 *
 * ## Scope, narrowly
 *
 * Only the DISCOVERY genuinely spans tenants, and it opens its own audited
 * bypass inside `aggregateStorageUsageByOrganization`. Everything after it is
 * ONE organization's work — its quota, its roster, its inbox rows — so it runs
 * inside `withTenant`, exactly as `lib/db/tenant-context.ts` asks ("a worker
 * should find its due work here and then do that work inside withTenant") and as
 * the workflow-fire worker already does.
 *
 * This is not decoration. The route declares `crossTenant`, so without this the
 * whole sweep would write inbox rows with row-level security switched off, and
 * an emitter bug that addressed a row to the wrong organization would be
 * silently accepted instead of refused by the table's `WITH CHECK` policy. The
 * bypass covers the aggregate and nothing after it.
 */
export async function runStorageAlertSweep(): Promise<StorageAlertSweepResult> {
  const thresholdPercent = storageAlertThresholdPercent()
  const usageByOrg = await aggregateStorageUsageByOrganization()

  const outcomes: StorageAlertOutcome[] = []
  for (const [organizationId, usage] of usageByOrg) {
    try {
      outcomes.push(
        await withTenant({ organizationId }, () =>
          evaluateStorageAlert(organizationId, usage.bytes, { thresholdPercent }),
        ),
      )
    } catch (error) {
      // One tenant's failure (a WorkOS timeout resolving its roster, say) must
      // not cost every other tenant its alert.
      console.error(`[storage-alert] evaluation failed for ${organizationId}:`, error)
    }
  }

  return {
    organizationsChecked: usageByOrg.size,
    alerted: outcomes.filter((outcome) => outcome.status === 'alerted').length,
    notified: outcomes.reduce((sum, outcome) => sum + outcome.notified, 0),
    retired: outcomes.reduce((sum, outcome) => sum + outcome.retired, 0),
    thresholdPercent,
  }
}
