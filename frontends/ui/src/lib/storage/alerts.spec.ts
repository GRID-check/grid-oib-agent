/**
 * @vitest-environment node
 */
/**
 * The storage-quota alert (ADR-0042).
 *
 * These tests exist because a passing type-check proves none of the four things
 * this feature actually promises. Each block below is written to FAIL if the
 * corresponding guarantee were dropped:
 *
 *   1. it fires ONCE per crossing, despite `upsertInboxItems` reviving a row on
 *      conflict — so a scheduled re-run must not re-surface a dismissed alert;
 *   2. a RE-crossing after a recovery alerts again, rather than being swallowed
 *      by the suppression that makes (1) work;
 *   3. recipients are whoever holds `org:settings:manage`, and an org with none
 *      logs instead of throwing;
 *   4. the per-org work runs inside a TENANT scope, not under the sweep's
 *      cross-tenant bypass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/inbox/repository', () => ({
  archiveInboxItemsOfType: vi.fn().mockResolvedValue(0),
  findLiveInboxGroupKeys: vi.fn().mockResolvedValue(new Set<string>()),
}))
vi.mock('@/lib/organizations/service', () => ({ listOrganizationMembersWithRoles: vi.fn() }))
vi.mock('./repository', () => ({ aggregateStorageUsageByOrganization: vi.fn() }))
vi.mock('./service', () => ({ getStorageQuotaBytes: vi.fn() }))

import { emitInboxItems } from '@/lib/inbox/service'
import { archiveInboxItemsOfType, findLiveInboxGroupKeys } from '@/lib/inbox/repository'
import { listOrganizationMembersWithRoles } from '@/lib/organizations/service'
import { getTenantContext } from '@/lib/db/tenant-context'
import type { OrganizationMemberWithRole } from '@/lib/organizations/service'
import { aggregateStorageUsageByOrganization } from './repository'
import { getStorageQuotaBytes } from './service'
import {
  STORAGE_ALERT_TYPE,
  crossedBucketPercent,
  evaluateStorageAlert,
  findStorageAlertRecipients,
  runStorageAlertSweep,
  storageAlertThresholdPercent,
} from './alerts'

/** 100 GB, so the percentages below are readable. */
const QUOTA = 100_000_000_000
const gb = (count: number): number => count * 1_000_000_000

/**
 * A membership row as `listOrganizationMembersWithRoles` returns it.
 *
 * Spelled out rather than cast: the recipient filter reads `status` and
 * `roleSlug`, and a partial fixture would let a renamed field pass silently
 * while the production filter stopped matching anybody.
 */
function member(overrides: Partial<OrganizationMemberWithRole> = {}): OrganizationMemberWithRole {
  return {
    id: 'user_admin',
    email: 'admin@tenant.test',
    name: 'Ada Admin',
    roleSlug: 'admin',
    status: 'active',
    ...overrides,
  }
}

/** The group key the emitter builds for a crossed bucket. */
const groupKeyFor = (organizationId: string, bucket: number): string =>
  `${STORAGE_ALERT_TYPE}:organization:${organizationId}:${bucket}`

/** The live-row key shape the suppression probe returns. */
const liveKey = (recipientUserId: string, organizationId: string, bucket: number): string =>
  `${recipientUserId}\n${groupKeyFor(organizationId, bucket)}`

beforeEach(() => {
  vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([member()])
  vi.mocked(getStorageQuotaBytes).mockResolvedValue(QUOTA)
  vi.mocked(findLiveInboxGroupKeys).mockResolvedValue(new Set<string>())
  vi.mocked(archiveInboxItemsOfType).mockResolvedValue(0)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('crossedBucketPercent — the decision, with no database near it', () => {
  it('is null below the threshold and at the threshold it is the threshold', () => {
    expect(crossedBucketPercent(gb(79), QUOTA, 80)).toBeNull()
    // Exactly 80% HAS crossed 80%: the alert says "80% of the quota is in use",
    // which is true at the boundary.
    expect(crossedBucketPercent(gb(80), QUOTA, 80)).toBe(80)
    expect(crossedBucketPercent(gb(85), QUOTA, 80)).toBe(80)
  })

  it('escalates, and full always gets its own bucket', () => {
    expect(crossedBucketPercent(gb(90), QUOTA, 80)).toBe(90)
    expect(crossedBucketPercent(gb(100), QUOTA, 80)).toBe(100)
    expect(crossedBucketPercent(gb(140), QUOTA, 80)).toBe(100)
  })

  it('is null for an unlimited org — there is no "full" to warn about', () => {
    expect(crossedBucketPercent(gb(999), null, 80)).toBeNull()
    expect(crossedBucketPercent(gb(999), 0, 80)).toBeNull()
  })

  it('drops ladder steps at or below a raised threshold', () => {
    // A threshold of 95 must not warn at 90 — the ladder is filtered, not fixed.
    expect(crossedBucketPercent(gb(92), QUOTA, 95)).toBeNull()
    expect(crossedBucketPercent(gb(96), QUOTA, 95)).toBe(95)
  })
})

describe('storageAlertThresholdPercent — configurable, default 80', () => {
  it('defaults to 80 when unset', () => {
    expect(storageAlertThresholdPercent(undefined)).toBe(80)
  })

  it('takes a configured value', () => {
    expect(storageAlertThresholdPercent('60')).toBe(60)
  })

  it('falls back to the default for nonsense rather than disabling the alert', () => {
    // A typo must not silently switch off the warning that stops a tenant
    // walking into a wall.
    for (const bad of ['', 'eighty', '0', '-5', '150', 'NaN']) {
      expect(storageAlertThresholdPercent(bad), bad).toBe(80)
    }
  })
})

/**
 * GUARANTEE 1 — once per crossing.
 *
 * `upsertInboxItems` sets `count = count + 1` and NULLs read/resolved/archived
 * /inert on conflict, so a re-emission does not dedupe: it REVIVES the row as
 * unread. The group key alone therefore cannot deliver "once", and these tests
 * fail if the emitter ever stops asking whether a live row already exists.
 */
describe('fires once per crossing, not once per sweep', () => {
  it('emits on the first crossing', async () => {
    const outcome = await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })

    expect(outcome.status).toBe('alerted')
    expect(outcome.notified).toBe(1)
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-emit while the alert is still live', async () => {
    // The probe answers "this recipient already has an unarchived row for this
    // bucket" — which is what the second sweep tick sees.
    vi.mocked(findLiveInboxGroupKeys).mockResolvedValue(
      new Set([liveKey('user_admin', 'org_1', 80)]),
    )

    const outcome = await evaluateStorageAlert('org_1', gb(83), { thresholdPercent: 80 })

    expect(outcome.status).toBe('suppressed')
    expect(outcome.notified).toBe(0)
    // The whole point: no upsert, so no count++ and no resurrection of a row the
    // recipient already read and dismissed.
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('asks about the exact (recipient, group key) pair, so suppression cannot be global', async () => {
    await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })

    expect(findLiveInboxGroupKeys).toHaveBeenCalledWith('org_1', [
      { recipientUserId: 'user_admin', groupKey: groupKeyFor('org_1', 80) },
    ])
  })

  it('suppresses per recipient: an admin who dismissed it is skipped, a new admin is told', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      member({ id: 'user_old' }),
      member({ id: 'user_new', email: 'new@tenant.test' }),
    ])
    vi.mocked(findLiveInboxGroupKeys).mockResolvedValue(new Set([liveKey('user_old', 'org_1', 80)]))

    const outcome = await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })

    expect(outcome.notified).toBe(1)
    const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]!
    expect(emissions.map((emission) => emission.recipientUserId)).toEqual(['user_new'])
  })

  it('escalation is a NEW crossing: a higher bucket alerts even while the lower one is live', async () => {
    vi.mocked(findLiveInboxGroupKeys).mockResolvedValue(new Set([liveKey('user_admin', 'org_1', 80)]))

    const outcome = await evaluateStorageAlert('org_1', gb(91), { thresholdPercent: 80 })

    // The bucket is part of the group key, so 90% is not the same alert as 80%.
    expect(outcome.status).toBe('alerted')
    expect(outcome.bucketPercent).toBe(90)
    // …and the superseded 80% row is retired in the same pass, so nobody ends up
    // with two rows about one disk.
    expect(archiveInboxItemsOfType).toHaveBeenCalledWith('org_1', STORAGE_ALERT_TYPE, {
      exceptAnchorId: '90',
    })
  })
})

/**
 * GUARANTEE 2 — a re-crossing alerts again.
 *
 * The mechanism is the mirror of guarantee 1: falling below the threshold
 * ARCHIVES the outstanding rows, and the suppression probe ignores archived
 * rows, so the next crossing is not suppressed. If the retire step were dropped
 * as "tidying", the second alert would be swallowed forever — the worst failure
 * this feature can have, because it looks like nothing is wrong.
 */
describe('recovering and re-crossing alerts again', () => {
  it('retires the outstanding alert when usage falls back below the threshold', async () => {
    vi.mocked(archiveInboxItemsOfType).mockResolvedValue(2)

    const outcome = await evaluateStorageAlert('org_1', gb(40), { thresholdPercent: 80 })

    expect(outcome.status).toBe('below-threshold')
    expect(outcome.retired).toBe(2)
    // Archived wholesale — no `exceptAnchorId`, because no bucket survives.
    expect(archiveInboxItemsOfType).toHaveBeenCalledWith('org_1', STORAGE_ALERT_TYPE)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('alerts again after a recovery, because the retired row is no longer live', async () => {
    // Tick 1: crosses.
    await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })
    expect(emitInboxItems).toHaveBeenCalledTimes(1)

    // Tick 2: recovers. The rows are archived, which is what re-arms the probe.
    vi.mocked(archiveInboxItemsOfType).mockResolvedValue(1)
    await evaluateStorageAlert('org_1', gb(50), { thresholdPercent: 80 })
    expect(emitInboxItems).toHaveBeenCalledTimes(1)

    // Tick 3: crosses again. The probe finds nothing live (archived rows are
    // excluded by `findLiveInboxGroupKeys`), so a fresh alert goes out.
    vi.mocked(findLiveInboxGroupKeys).mockResolvedValue(new Set<string>())
    const outcome = await evaluateStorageAlert('org_1', gb(84), { thresholdPercent: 80 })

    expect(outcome.status).toBe('alerted')
    expect(outcome.notified).toBe(1)
    expect(emitInboxItems).toHaveBeenCalledTimes(2)
  })

  it('an unlimited org retires any alert it was carrying and reports unlimited', async () => {
    vi.mocked(getStorageQuotaBytes).mockResolvedValue(null)
    vi.mocked(archiveInboxItemsOfType).mockResolvedValue(1)

    const outcome = await evaluateStorageAlert('org_1', gb(9999))

    expect(outcome.status).toBe('unlimited')
    expect(outcome.usedPercent).toBeNull()
    expect(outcome.retired).toBe(1)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

/**
 * GUARANTEE 3 — recipients are permission-derived.
 */
describe('recipient resolution', () => {
  it('notifies holders of org:settings:manage, via the role catalog', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      member({ id: 'user_admin', roleSlug: 'admin' }),
      // Holds org:audit:view only — can read the audit trail, cannot free space
      // or raise the quota, so telling them would be noise they cannot act on.
      member({ id: 'user_auditor', roleSlug: 'org-auditor' }),
      member({ id: 'user_member', roleSlug: 'member' }),
    ])

    expect(await findStorageAlertRecipients('org_1')).toEqual(['user_admin'])
  })

  it('ignores inactive memberships', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      member({ id: 'user_pending', status: 'pending' }),
      member({ id: 'user_inactive', status: 'inactive' }),
    ])

    expect(await findStorageAlertRecipients('org_1')).toEqual([])
  })

  it('does not assume an unknown role holds the permission', async () => {
    // Guessing permissively here would mail an organization's storage position
    // to whoever happens to hold a custom WorkOS role.
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      member({ id: 'user_custom', roleSlug: 'some-deployment-specific-role' }),
      member({ id: 'user_roleless', roleSlug: null }),
    ])

    expect(await findStorageAlertRecipients('org_1')).toEqual([])
  })

  it('logs and does not throw when nobody can act on it', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([member({ roleSlug: 'member' })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })

    expect(outcome.status).toBe('no-recipients')
    expect(outcome.notified).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
    // An operator has to be able to see that a tenant is heading for a wall with
    // nobody home; silently returning would hide it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no active member holding'))
    warn.mockRestore()
  })

  it('carries the payload the row renders, with no invented actor', async () => {
    await evaluateStorageAlert('org_1', gb(82), { thresholdPercent: 80 })

    const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]!
    expect(emissions).toHaveLength(1)
    expect(emissions[0]).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'user_admin',
      type: STORAGE_ALERT_TYPE,
      resourceType: 'organization',
      resourceId: 'org_1',
      anchorId: '80',
      // System-generated: naming a fake colleague would be a lie in the row.
      actorUserId: null,
      groupKey: groupKeyFor('org_1', 80),
    })
    // `subject` is the only payload key the row renders, and the sentence around
    // it is localised, so it stays a locale-neutral token.
    expect(emissions[0]!.payload).toMatchObject({ subject: '82%', usedPercent: 82 })
  })
})

/**
 * GUARANTEE 4 — the sweep, and the scope it does per-org work in.
 */
describe('runStorageAlertSweep', () => {
  beforeEach(() => {
    vi.mocked(aggregateStorageUsageByOrganization).mockResolvedValue(
      new Map([
        ['org_low', { bytes: gb(10), documents: 3 }],
        ['org_high', { bytes: gb(85), documents: 40 }],
      ]),
    )
  })

  it('visits every organization with stored bytes and totals the outcome', async () => {
    const result = await runStorageAlertSweep()

    expect(result).toMatchObject({ organizationsChecked: 2, alerted: 1, notified: 1 })
    expect(result.thresholdPercent).toBe(80)
  })

  it('does the per-org work inside that org\'s TENANT scope, not the cross-tenant bypass', async () => {
    // The route declares `crossTenant`, so without the narrowing in the sweep
    // every inbox write would run with row-level security switched off and a
    // misaddressed row would be accepted rather than refused by WITH CHECK.
    const scopes: (string | undefined)[] = []
    vi.mocked(listOrganizationMembersWithRoles).mockImplementation(async () => {
      const context = getTenantContext()
      scopes.push(context?.kind === 'tenant' ? context.organizationId : context?.kind)
      return [member()]
    })

    await runStorageAlertSweep()

    // Only the org over the threshold resolves recipients, and it does so as
    // itself — never as 'platform'.
    expect(scopes).toEqual(['org_high'])
  })

  it('one tenant\'s failure does not cost the others their alert', async () => {
    vi.mocked(aggregateStorageUsageByOrganization).mockResolvedValue(
      new Map([
        ['org_broken', { bytes: gb(90), documents: 1 }],
        ['org_ok', { bytes: gb(85), documents: 1 }],
      ]),
    )
    vi.mocked(listOrganizationMembersWithRoles).mockImplementation(async (organizationId) => {
      if (organizationId === 'org_broken') throw new Error('WorkOS timed out')
      return [member()]
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runStorageAlertSweep()

    expect(result.organizationsChecked).toBe(2)
    expect(result.alerted).toBe(1)
    expect(result.notified).toBe(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('org_broken'),
      expect.any(Error),
    )
    error.mockRestore()
  })

  it('honours the configured threshold for the whole sweep', async () => {
    vi.stubEnv('GRID_STORAGE_ALERT_THRESHOLD_PERCENT', '50')
    vi.mocked(aggregateStorageUsageByOrganization).mockResolvedValue(
      new Map([['org_mid', { bytes: gb(60), documents: 5 }]]),
    )

    const result = await runStorageAlertSweep()

    // 60% would be silent at the default threshold and alerts at 50.
    expect(result.thresholdPercent).toBe(50)
    expect(result.alerted).toBe(1)
  })
})
