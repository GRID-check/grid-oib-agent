/**
 * SQL for the project mail inbox (migration 0102). No authorization here: the
 * service decides who may ask, and row-level security is the backstop.
 *
 * Every function runs in whatever tenant scope its caller opened, with one
 * group of exceptions that say so: {@link findActiveAddressByToken} is the
 * lookup that happens BEFORE any organization is known, and the drain's claim,
 * reaper and retention sweeps span every organization. Their callers wrap them
 * in `withPlatformAccess` and do each row's work inside `withTenant`.
 */

import 'server-only'
import { and, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import {
  inboundMailAddresses,
  inboundMailMessages,
  projects,
  type InboundMailAddressRow,
  type InboundMailMessageRow,
  type InboundMailMessageStatus,
  type SkippedAttachment,
  type StagedAttachment,
} from '@/lib/db/schema'

/** What the webhook learns from a token, and nothing more. */
export interface ResolvedAddress {
  addressId: string
  organizationId: string
  projectId: string
}

/**
 * The active address a token names, in whichever organization owns it.
 *
 * Cross-tenant by nature — the token is all the webhook has — so the caller
 * runs it under the platform bypass, and it returns ONLY the three ids the
 * rest of the request needs to open a tenant scope. A revoked token, and a
 * token whose project is soft-deleted, resolve to nothing: the same answer as
 * a token nobody ever minted.
 */
export async function findActiveAddressByToken(token: string): Promise<ResolvedAddress | null> {
  const [row] = await getDb()
    .select({
      addressId: inboundMailAddresses.id,
      organizationId: inboundMailAddresses.organizationId,
      projectId: inboundMailAddresses.projectId,
    })
    .from(inboundMailAddresses)
    .innerJoin(
      projects,
      and(
        eq(projects.id, inboundMailAddresses.projectId),
        eq(projects.organizationId, inboundMailAddresses.organizationId)
      )
    )
    .where(
      and(
        eq(inboundMailAddresses.token, token),
        isNull(inboundMailAddresses.revokedAt),
        isNull(projects.deletedAt)
      )
    )
    .limit(1)
  return row ?? null
}

/** The project's active address, if it has one. */
export async function findActiveAddressForProject(
  organizationId: string,
  projectId: string
): Promise<InboundMailAddressRow | null> {
  const [row] = await getDb()
    .select()
    .from(inboundMailAddresses)
    .where(
      and(
        eq(inboundMailAddresses.organizationId, organizationId),
        eq(inboundMailAddresses.projectId, projectId),
        isNull(inboundMailAddresses.revokedAt)
      )
    )
    .limit(1)
  return row ?? null
}

export interface NewAddress {
  organizationId: string
  projectId: string
  token: string
  slug: string
  createdBy: string
}

/**
 * Insert an address, or report which uniqueness it lost to.
 *
 * `token` means the random token collided (vanishingly rare at 60 bits, and
 * the caller mints another); `active` means a concurrent request already gave
 * the project its active address, which the caller then reads back.
 */
export async function insertAddress(
  input: NewAddress
): Promise<{ ok: true; row: InboundMailAddressRow } | { ok: false; conflict: 'token' | 'active' }> {
  try {
    const [row] = await getDb().insert(inboundMailAddresses).values(input).returning()
    return { ok: true, row }
  } catch (error) {
    if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_token')) return { ok: false, conflict: 'token' }
    if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_active_project')) {
      return { ok: false, conflict: 'active' }
    }
    throw error
  }
}

/**
 * Revoke the project's active address and insert its successor, atomically: a
 * project never has two active addresses, and never none after a rotation.
 */
export async function rotateAddress(
  input: NewAddress & { revokedBy: string }
): Promise<{ ok: true; row: InboundMailAddressRow } | { ok: false; conflict: 'token' | 'active' }> {
  const { revokedBy, ...next } = input
  try {
    const row = await getDb().transaction(async (tx) => {
      await tx
        .update(inboundMailAddresses)
        .set({ revokedAt: new Date(), revokedBy })
        .where(
          and(
            eq(inboundMailAddresses.organizationId, input.organizationId),
            eq(inboundMailAddresses.projectId, input.projectId),
            isNull(inboundMailAddresses.revokedAt)
          )
        )
      const [inserted] = await tx.insert(inboundMailAddresses).values(next).returning()
      return inserted
    })
    return { ok: true, row }
  } catch (error) {
    if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_token')) return { ok: false, conflict: 'token' }
    if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_active_project')) {
      return { ok: false, conflict: 'active' }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Deliveries: the webhook's half (inside the address's organization)
// ---------------------------------------------------------------------------

/** A delivery already recorded for this (address, mail). */
export interface ExistingDelivery {
  id: string
  status: InboundMailMessageStatus
}

/** The row for this mail at this address, if one exists. */
export async function findDelivery(addressId: string, deliveryKey: string): Promise<ExistingDelivery | null> {
  const [row] = await getDb()
    .select({ id: inboundMailMessages.id, status: inboundMailMessages.status })
    .from(inboundMailMessages)
    .where(and(eq(inboundMailMessages.addressId, addressId), eq(inboundMailMessages.deliveryKey, deliveryKey)))
    .limit(1)
  return row ?? null
}

export interface NewDelivery extends ResolvedAddress {
  /** Minted by the caller: the staged object keys already carry it. */
  id: string
  deliveryKey: string
  senderUserId: string
  folderName: string
  subject: string | null
  stagingBucket: string | null
  staged: StagedAttachment[]
  skipped: SkippedAttachment[]
  receivedAt: Date
}

/**
 * Queue a delivery, or re-queue one that was given up on.
 *
 * Returns the id of the row that now holds this mail's staging, or `null` when
 * a row for it is already `queued`, `processing` or `filed`: a duplicate, whose
 * caller discards its own staging. A `failed` row is taken over in place (the
 * sender sent it again after being told it failed), keeping its folder so the
 * second try lands beside whatever the first one filed.
 */
export async function queueDelivery(input: NewDelivery): Promise<string | null> {
  const [row] = await getDb()
    .insert(inboundMailMessages)
    .values({ ...input, status: 'queued' })
    .onConflictDoUpdate({
      target: [inboundMailMessages.addressId, inboundMailMessages.deliveryKey],
      set: {
        status: 'queued',
        senderUserId: input.senderUserId,
        subject: input.subject,
        stagingBucket: input.stagingBucket,
        staged: input.staged,
        skipped: input.skipped,
        filedCount: 0,
        skippedCount: 0,
        attempts: 0,
        nextAttemptAt: sql`now()`,
        lastError: null,
        updatedAt: sql`now()`,
      },
      setWhere: eq(inboundMailMessages.status, 'failed'),
    })
    .returning({ id: inboundMailMessages.id })
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// Deliveries: the drain's half
// ---------------------------------------------------------------------------

/** How long an attempt may go without a heartbeat before it is presumed dead. */
export const STALE_CLAIM_SECONDS = 10 * 60

/** A delivery a drain attempt owns: every write of that attempt names `claimToken`. */
export type ClaimedDelivery = InboundMailMessageRow & { claimToken: string }

/**
 * Claim the next due delivery of ANY organization, or `null` when none is due.
 *
 * NOT tenant-filtered: the caller runs it under platform access and does the
 * row's work inside the row's own organization. The subquery's
 * `FOR UPDATE SKIP LOCKED` keeps two drains off one row, and the fresh
 * `claim_token` is what every later write of this attempt is fenced on, so an
 * attempt that stalls past {@link STALE_CLAIM_SECONDS} and is reaped cannot
 * write over the attempt that took the row after it.
 */
export async function claimNextDelivery(): Promise<ClaimedDelivery | null> {
  const db = getDb()
  const due = db
    .select({ id: inboundMailMessages.id })
    .from(inboundMailMessages)
    .where(and(eq(inboundMailMessages.status, 'queued'), lte(inboundMailMessages.nextAttemptAt, sql`now()`)))
    .orderBy(inboundMailMessages.nextAttemptAt)
    .limit(1)
    .for('update', { skipLocked: true })
  const [row] = await db
    .update(inboundMailMessages)
    .set({
      status: 'processing',
      claimToken: sql`gen_random_uuid()`,
      attempts: sql`${inboundMailMessages.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(inboundMailMessages.id, due))
    .returning()
  if (!row?.claimToken) return null
  return { ...row, claimToken: row.claimToken }
}

/**
 * Hand every attempt whose heartbeat stopped back to the queue. Platform scope.
 * Its attempt stays counted, so a row that keeps killing the drain still
 * reaches the give-up. Returns how many were reaped.
 */
export async function reapStaleClaims(staleSeconds: number = STALE_CLAIM_SECONDS): Promise<number> {
  const rows = await getDb()
    .update(inboundMailMessages)
    .set({ status: 'queued', claimToken: null, nextAttemptAt: sql`now()`, lastError: 'stale-claim' })
    .where(
      and(
        eq(inboundMailMessages.status, 'processing'),
        lt(inboundMailMessages.updatedAt, sql`now() - make_interval(secs => ${staleSeconds})`)
      )
    )
    .returning({ id: inboundMailMessages.id })
  return rows.length
}

/** The fence: this row, still owned by this attempt. */
function ownedBy(id: string, claimToken: string) {
  return and(
    eq(inboundMailMessages.id, id),
    eq(inboundMailMessages.claimToken, claimToken),
    eq(inboundMailMessages.status, 'processing')
  )
}

async function fencedUpdate(
  id: string,
  claimToken: string,
  values: PgUpdateSetSource<typeof inboundMailMessages>
): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailMessages)
    .set({ ...values, updatedAt: sql`now()` })
    .where(ownedBy(id, claimToken))
    .returning({ id: inboundMailMessages.id })
  return rows.length > 0
}

/** The attempt is alive. `false` means it lost the row and must stop writing. */
export function heartbeat(id: string, claimToken: string): Promise<boolean> {
  return fencedUpdate(id, claimToken, {})
}

/** Remember the folder the first filing created, for every later attempt. */
export function recordDeliveryFolder(id: string, claimToken: string, folderId: string): Promise<boolean> {
  return fencedUpdate(id, claimToken, { folderId })
}

/** What a finished delivery keeps: counts and reason codes, no names, no subject. */
export interface DeliveryOutcome {
  filedCount: number
  skipped: SkippedAttachment[]
  /** Staged objects that could not be deleted; the staging backstop retries them. */
  remaining: StagedAttachment[]
  lastError?: string | null
}

function terminalValues(outcome: DeliveryOutcome) {
  return {
    claimToken: null,
    subject: null,
    staged: outcome.remaining,
    skipped: outcome.skipped.map(({ reason }) => ({ reason })),
    filedCount: outcome.filedCount,
    skippedCount: outcome.skipped.length,
    lastError: outcome.lastError ?? null,
  }
}

export function markDeliveryFiled(id: string, claimToken: string, outcome: DeliveryOutcome): Promise<boolean> {
  return fencedUpdate(id, claimToken, { status: 'filed', ...terminalValues(outcome) })
}

export function markDeliveryFailed(id: string, claimToken: string, outcome: DeliveryOutcome): Promise<boolean> {
  return fencedUpdate(id, claimToken, { status: 'failed', ...terminalValues(outcome) })
}

/** This attempt failed; queue the next one after `delaySeconds`. */
export function scheduleRetry(
  id: string,
  claimToken: string,
  delaySeconds: number,
  lastError: string
): Promise<boolean> {
  return fencedUpdate(id, claimToken, {
    status: 'queued',
    claimToken: null,
    nextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})`,
    lastError,
  })
}

/**
 * Give the row back without spending an attempt: the drain is holding off
 * (the organization's switch is off), which is not the mail's failure.
 */
export function releaseClaim(id: string, claimToken: string, delaySeconds: number): Promise<boolean> {
  return fencedUpdate(id, claimToken, {
    status: 'queued',
    claimToken: null,
    attempts: sql`GREATEST(${inboundMailMessages.attempts} - 1, 0)`,
    nextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})`,
    lastError: 'held',
  })
}

// ---------------------------------------------------------------------------
// Retention (platform scope)
// ---------------------------------------------------------------------------

/** Rows are bookkeeping for thirty days, then gone (privacy note §6). */
export const DELIVERY_RETENTION_DAYS = 30

/** Staged attachments older than this are deleted whatever became of the row. */
export const STAGING_RETENTION_DAYS = 7

/** Delete delivery rows received more than `days` ago. Returns how many. */
export async function deleteDeliveriesOlderThan(days: number = DELIVERY_RETENTION_DAYS): Promise<number> {
  const rows = await getDb()
    .delete(inboundMailMessages)
    .where(
      and(
        lt(inboundMailMessages.receivedAt, sql`now() - make_interval(days => ${days})`),
        // Never under a live attempt; it is reaped first and deleted next time.
        sql`${inboundMailMessages.status} <> 'processing'`,
        // Never while it still names staged objects: the row is how the
        // staging backstop and the project purge find the bucket they are in.
        sql`${inboundMailMessages.staged} = '[]'::jsonb`
      )
    )
    .returning({ id: inboundMailMessages.id })
  return rows.length
}

/** Rows not owned by an attempt whose staging is older than `days`. */
export async function findExpiredStaging(
  limit: number,
  days: number = STAGING_RETENTION_DAYS
): Promise<InboundMailMessageRow[]> {
  return getDb()
    .select()
    .from(inboundMailMessages)
    .where(
      and(
        sql`${inboundMailMessages.staged} <> '[]'::jsonb`,
        sql`${inboundMailMessages.status} <> 'processing'`,
        lt(inboundMailMessages.receivedAt, sql`now() - make_interval(days => ${days})`)
      )
    )
    .orderBy(inboundMailMessages.receivedAt)
    .limit(limit)
}

/**
 * The staging of an expired row is gone. A row still `queued` can never be
 * filed now, so it fails; conditional on the status the caller read, so a
 * concurrent claim is never overwritten. Returns whether it applied.
 */
export async function clearExpiredStaging(
  row: Pick<InboundMailMessageRow, 'id' | 'status'>,
  remaining: StagedAttachment[]
): Promise<boolean> {
  const fails = row.status === 'queued'
  const rows = await getDb()
    .update(inboundMailMessages)
    .set({
      staged: remaining,
      ...(fails ? { status: 'failed' as const, subject: null, lastError: 'staging-expired' } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(inboundMailMessages.id, row.id), eq(inboundMailMessages.status, row.status)))
    .returning({ id: inboundMailMessages.id })
  return rows.length > 0
}
