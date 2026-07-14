/**
 * Drive-credentials repository — the only module that talks to the
 * `drive_credentials` table (ADR-0025).
 *
 * Repository rules: drizzle only; tenancy enforced in SQL (every user-facing
 * query is scoped by userId + organizationId); lists are bounded.
 */

import 'server-only'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { driveCredentials, type DriveCredential, type NewDriveCredential } from '@/lib/db/schema'

/** A user shouldn't have unbounded devices; the list (and UI) cap. */
export const DRIVE_CREDENTIAL_LIST_LIMIT = 50

export async function insertDriveCredential(values: NewDriveCredential): Promise<DriveCredential> {
  const db = getDb()
  const [row] = await db.insert(driveCredentials).values(values).returning()
  return row
}

/** Lookup by primary key — the verification hot path (id is embedded in the secret). */
export async function findDriveCredentialById(id: string): Promise<DriveCredential | null> {
  const db = getDb()
  const [row] = await db.select().from(driveCredentials).where(eq(driveCredentials.id, id)).limit(1)
  return row ?? null
}

/** Summary shape for the "connected devices" UI — never includes the hash. */
export interface DriveCredentialSummary {
  id: string
  label: string
  username: string
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
}

/** Non-revoked credentials for a user in an org, newest first, bounded. */
export async function listDriveCredentialsForUser(
  userId: string,
  organizationId: string,
  limit = DRIVE_CREDENTIAL_LIST_LIMIT,
): Promise<DriveCredentialSummary[]> {
  const db = getDb()
  return db
    .select({
      id: driveCredentials.id,
      label: driveCredentials.label,
      username: driveCredentials.username,
      createdAt: driveCredentials.createdAt,
      expiresAt: driveCredentials.expiresAt,
      lastUsedAt: driveCredentials.lastUsedAt,
    })
    .from(driveCredentials)
    .where(
      and(
        eq(driveCredentials.userId, userId),
        eq(driveCredentials.organizationId, organizationId),
        isNull(driveCredentials.revokedAt),
      ),
    )
    .orderBy(desc(driveCredentials.createdAt))
    .limit(limit)
}

/**
 * Revoke a credential scoped to its owner. Returns the revoked row, or null
 * when nothing matched (missing, cross-tenant, someone else's, or already
 * revoked) — the caller maps that to 404.
 */
export async function revokeDriveCredentialForUser(
  id: string,
  userId: string,
  organizationId: string,
): Promise<DriveCredential | null> {
  const db = getDb()
  const [row] = await db
    .update(driveCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(driveCredentials.id, id),
        eq(driveCredentials.userId, userId),
        eq(driveCredentials.organizationId, organizationId),
        isNull(driveCredentials.revokedAt),
      ),
    )
    .returning()
  return row ?? null
}

/** Best-effort "device was seen" stamp; never on the verification's hot path. */
export async function touchDriveCredentialLastUsed(id: string): Promise<void> {
  const db = getDb()
  await db.update(driveCredentials).set({ lastUsedAt: new Date() }).where(eq(driveCredentials.id, id))
}
