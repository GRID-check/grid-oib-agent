/**
 * SQL for the project mail inbox (migration 0101). No authorization here: the
 * service decides who may ask, and row-level security is the backstop.
 *
 * Every function runs in whatever tenant scope its caller opened, with one
 * exception that says so in its name: {@link findActiveAddressByToken} is the
 * lookup that happens BEFORE any organization is known, and its caller wraps it
 * in `withPlatformAccess`.
 */

import 'server-only'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import {
  inboundMailAddresses,
  inboundMailMessages,
  projects,
  type InboundMailAddressRow,
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

/** How long a `processing` row is trusted before another delivery may take it over. */
export const STALE_PROCESSING_MS = 15 * 60 * 1000

export interface ClaimInput extends ResolvedAddress {
  messageIdHash: string
}

/**
 * What a delivery may do with its message:
 *   - `claimed`   — it owns the row now and files the mail;
 *   - `duplicate` — the mail was filed before; nothing to do;
 *   - `busy`      — another delivery is filing it right now.
 */
export type ClaimOutcome =
  | { kind: 'claimed'; messageRowId: string }
  | { kind: 'duplicate'; messageRowId: string; filedCount: number }
  | { kind: 'busy' }

/**
 * Take the idempotency row for this (address, message), creating it on first
 * delivery and re-taking it after a failure or a stale run.
 */
export async function claimMessage(input: ClaimInput, now: Date = new Date()): Promise<ClaimOutcome> {
  const db = getDb()
  const [created] = await db
    .insert(inboundMailMessages)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      addressId: input.addressId,
      messageIdHash: input.messageIdHash,
    })
    .onConflictDoNothing({ target: [inboundMailMessages.addressId, inboundMailMessages.messageIdHash] })
    .returning({ id: inboundMailMessages.id })
  if (created) return { kind: 'claimed', messageRowId: created.id }

  const [existing] = await db
    .select()
    .from(inboundMailMessages)
    .where(
      and(
        eq(inboundMailMessages.addressId, input.addressId),
        eq(inboundMailMessages.messageIdHash, input.messageIdHash)
      )
    )
    .limit(1)
  if (!existing) return { kind: 'busy' }
  if (existing.status === 'filed') {
    return { kind: 'duplicate', messageRowId: existing.id, filedCount: existing.filedCount }
  }

  // `failed`, or `processing` that nobody has touched for the stale window.
  // Conditional, so two redeliveries racing for the same stale row cannot both win.
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS)
  const [retaken] = await db
    .update(inboundMailMessages)
    .set({
      status: 'processing',
      attempts: sql`${inboundMailMessages.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(inboundMailMessages.id, existing.id),
        or(
          eq(inboundMailMessages.status, 'failed'),
          and(eq(inboundMailMessages.status, 'processing'), lt(inboundMailMessages.updatedAt, staleBefore))
        )
      )
    )
    .returning({ id: inboundMailMessages.id })
  return retaken ? { kind: 'claimed', messageRowId: retaken.id } : { kind: 'busy' }
}

/** The mail is filed: record who sent it and what happened to its parts. */
export async function markMessageFiled(
  messageRowId: string,
  outcome: { senderUserId: string; filedCount: number; skippedCount: number }
): Promise<void> {
  await getDb()
    .update(inboundMailMessages)
    .set({ status: 'filed', ...outcome, updatedAt: new Date() })
    .where(eq(inboundMailMessages.id, messageRowId))
}

/** Filing broke part-way; a redelivery may try again. */
export async function markMessageFailed(messageRowId: string): Promise<void> {
  await getDb()
    .update(inboundMailMessages)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(inboundMailMessages.id, messageRowId))
}
