/**
 * SQL for the project mail inbox (migration 0109). No authorization here: the
 * service decides who may ask, and row-level security is the backstop.
 *
 * Every function runs in whatever tenant scope its caller opened, with one
 * group of exceptions that say so: {@link findActiveAddressByToken} is the
 * lookup that happens BEFORE any organization is known, and the sweep and the
 * retention span every organization. Their callers wrap them
 * in `withPlatformAccess` and do each row's work inside `withTenant`.
 */

import 'server-only'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
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
 * a row for it is already `queued` or `filed`: a duplicate, whose
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
        lastError: null,
        updatedAt: sql`now()`,
      },
      setWhere: eq(inboundMailMessages.status, 'failed'),
    })
    .returning({ id: inboundMailMessages.id })
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// Deliveries: the job's half (inside the delivery's organization)
// ---------------------------------------------------------------------------

/**
 * Every write below is conditional on the row still being `queued`. That is
 * the fence: the queue hands one job one claim, but a delivery can have a
 * second job (the sweep re-queued it while the first was slow), and the first
 * of them to finish the mail decides. A `false` answer means the mail is no
 * longer this job's to touch.
 */
function stillQueued(organizationId: string, id: string) {
  return and(
    eq(inboundMailMessages.organizationId, organizationId),
    eq(inboundMailMessages.id, id),
    eq(inboundMailMessages.status, 'queued')
  )
}

async function updateQueued(
  organizationId: string,
  id: string,
  values: PgUpdateSetSource<typeof inboundMailMessages>
): Promise<boolean> {
  const rows = await getDb()
    .update(inboundMailMessages)
    .set({ ...values, updatedAt: sql`now()` })
    .where(stillQueued(organizationId, id))
    .returning({ id: inboundMailMessages.id })
  return rows.length > 0
}

/** The delivery a job was handed, whatever its status. */
export async function findDeliveryRow(organizationId: string, id: string): Promise<InboundMailMessageRow | null> {
  const [row] = await getDb()
    .select()
    .from(inboundMailMessages)
    .where(and(eq(inboundMailMessages.organizationId, organizationId), eq(inboundMailMessages.id, id)))
    .limit(1)
  return row ?? null
}

/** The job is still filing this mail: the sweep leaves a delivery with recent progress alone. */
export function touchDelivery(organizationId: string, id: string): Promise<boolean> {
  return updateQueued(organizationId, id, {})
}

/** Remember the folder the first filing created, for every later attempt. */
export function recordDeliveryFolder(organizationId: string, id: string, folderId: string): Promise<boolean> {
  return updateQueued(organizationId, id, { folderId })
}

/** An attempt failed and the delivery waits for the next one: count it, and say why. */
export function recordFailedAttempt(
  organizationId: string,
  id: string,
  attempts: number,
  lastError: string
): Promise<boolean> {
  return updateQueued(organizationId, id, { attempts, lastError })
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
    subject: null,
    staged: outcome.remaining,
    skipped: outcome.skipped.map(({ reason }) => ({ reason })),
    filedCount: outcome.filedCount,
    skippedCount: outcome.skipped.length,
    lastError: outcome.lastError ?? null,
  }
}

export function markDeliveryFiled(organizationId: string, id: string, outcome: DeliveryOutcome): Promise<boolean> {
  return updateQueued(organizationId, id, { status: 'filed', ...terminalValues(outcome) })
}

export function markDeliveryFailed(organizationId: string, id: string, outcome: DeliveryOutcome): Promise<boolean> {
  return updateQueued(organizationId, id, { status: 'failed', ...terminalValues(outcome) })
}

// ---------------------------------------------------------------------------
// The sweep and retention (platform scope)
// ---------------------------------------------------------------------------

/**
 * Queued deliveries of ANY organization that have made no progress since
 * `before`: the candidates for "nothing is filing this". The caller asks the
 * job queue whether one still has a job, inside the row's own organization.
 */
export async function listStalledDeliveries(before: Date, limit: number): Promise<InboundMailMessageRow[]> {
  return getDb()
    .select()
    .from(inboundMailMessages)
    .where(and(eq(inboundMailMessages.status, 'queued'), lt(inboundMailMessages.updatedAt, before)))
    .orderBy(inboundMailMessages.updatedAt)
    .limit(limit)
}

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
        // Never while it still names staged objects: the row is how the
        // staging backstop and the project purge find the bucket they are in.
        sql`${inboundMailMessages.staged} = '[]'::jsonb`
      )
    )
    .returning({ id: inboundMailMessages.id })
  return rows.length
}

/** Rows whose staging is older than `days`, whatever their status. */
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
        lt(inboundMailMessages.receivedAt, sql`now() - make_interval(days => ${days})`)
      )
    )
    .orderBy(inboundMailMessages.receivedAt)
    .limit(limit)
}

/**
 * The staging of an expired row is gone. A row still `queued` can never be
 * filed now, so it fails; conditional on the status the caller read, so a job
 * that finished the row meanwhile is never overwritten. Returns whether it
 * applied.
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
