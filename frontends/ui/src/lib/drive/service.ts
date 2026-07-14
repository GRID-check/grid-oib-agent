/**
 * Drive-credentials service — SSO-brokered mount identity (ADR-0025).
 *
 * Native macOS/Windows mount dialogs can only present username+password, so the
 * SSO moment happens HERE, in the web app: a credential can only be minted
 * inside a WorkOS-SSO'd session. The high-entropy secret is shown exactly once,
 * stored only as a SHA-256 hash, expires (forcing a periodic return through
 * SSO), and is revocable. It authenticates the mount and nothing more — every
 * file operation is still authorized live against WorkOS FGA, so a credential
 * grants zero access the moment the user's role/membership goes away.
 *
 * Secret format: `gdk_<32 hex chars: credential uuid>.<43 chars: 32 random
 * bytes, base64url>`. Embedding the id makes verification a single primary-key
 * lookup followed by one constant-time hash comparison — no scanning, and no
 * timing oracle on which part failed.
 */

import 'server-only'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { recordAuditEvent } from '@/lib/audit/service'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  DRIVE_CREDENTIAL_LIST_LIMIT,
  findDriveCredentialById,
  insertDriveCredential,
  listDriveCredentialsForUser,
  revokeDriveCredentialForUser,
  touchDriveCredentialLastUsed,
  type DriveCredentialSummary,
} from './repository'

const SECRET_PREFIX = 'gdk_'

/** How long a device may mount before its user must re-pass SSO in the web app. */
const ttlDays = (): number => {
  const n = Number(process.env.DRIVE_CREDENTIAL_TTL_DAYS || 90)
  return Number.isFinite(n) && n > 0 ? n : 90
}

/** Advertised WebDAV mount URL (ingress-terminated HTTPS), if configured. */
const webdavUrl = (): string | null => process.env.DRIVE_WEBDAV_URL || null

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

/** uuid → 32 lowercase hex chars (dashes stripped) and back. */
const uuidToHex = (id: string): string => id.replace(/-/g, '').toLowerCase()
const hexToUuid = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

/** Parse a presented secret into its embedded credential id; null if malformed. */
export function parseSecretCredentialId(secret: string): string | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null
  const rest = secret.slice(SECRET_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot !== 32) return null // uuid hex is exactly 32 chars
  const idHex = rest.slice(0, dot)
  const random = rest.slice(dot + 1)
  if (!/^[0-9a-f]{32}$/.test(idHex)) return null
  if (random.length < 32) return null // 32 bytes base64url = 43 chars; reject short garbage
  return hexToUuid(idHex)
}

export interface CreatedDriveCredential {
  id: string
  label: string
  /** What the OS mount dialog calls "user name" — the user's email. */
  username: string
  /** Shown exactly once; only its hash is stored. */
  secret: string
  expiresAt: Date
  webdavUrl: string | null
}

export async function createDriveCredential(
  session: AuthorizedSession,
  input: { label: string },
  request: Request,
): Promise<CreatedDriveCredential> {
  const label = input.label.trim().slice(0, 64)
  if (!label) throw new BadRequestError('A device label is required')

  const existing = await listDriveCredentialsForUser(session.userId, session.organizationId)
  if (existing.length >= DRIVE_CREDENTIAL_LIST_LIMIT) {
    throw new BadRequestError('Too many active drive credentials; revoke one first')
  }

  const id = randomUUID()
  const secret = `${SECRET_PREFIX}${uuidToHex(id)}.${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(Date.now() + ttlDays() * 24 * 60 * 60 * 1000)

  await insertDriveCredential({
    id,
    userId: session.userId,
    organizationId: session.organizationId,
    username: session.email,
    label,
    secretHash: hashSecret(secret),
    expiresAt,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'drive.credential_created',
    targetType: 'drive_credential',
    targetId: id,
    metadata: { label, expiresAt: expiresAt.toISOString() },
    request,
  })

  return { id, label, username: session.email, secret, expiresAt, webdavUrl: webdavUrl() }
}

export async function listDriveCredentials(session: AuthorizedSession): Promise<DriveCredentialSummary[]> {
  return listDriveCredentialsForUser(session.userId, session.organizationId)
}

export async function revokeDriveCredential(
  session: AuthorizedSession,
  credentialId: string,
  request: Request,
): Promise<void> {
  const revoked = await revokeDriveCredentialForUser(credentialId, session.userId, session.organizationId)
  if (!revoked) throw new NotFoundError()

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'drive.credential_revoked',
    targetType: 'drive_credential',
    targetId: credentialId,
    metadata: { label: revoked.label },
    request,
  })
}

export interface MountAuthResult {
  allow: boolean
  userId?: string
  organizationId?: string
}

/**
 * Verify a mount credential presented as WebDAV Basic auth (the gateway calls
 * this via POST /api/internal/mount-auth). Fail-closed on everything: malformed
 * secret, unknown id, revoked, expired, username mismatch, or hash mismatch all
 * yield a uniform `{allow:false}` — no distinguishing detail leaves the BFF.
 *
 * The secret embeds the credential id, so this is one PK lookup plus one
 * constant-time hash compare; brute force is hopeless against 256 bits of
 * entropy and each attempt costs the attacker a full round trip.
 */
export async function verifyMountCredential(input: {
  username: string
  secret: string
}): Promise<MountAuthResult> {
  const deny: MountAuthResult = { allow: false }

  const credentialId = parseSecretCredentialId(input.secret)
  if (!credentialId) return deny

  const row = await findDriveCredentialById(credentialId)
  if (!row) return deny
  if (row.revokedAt) return deny
  if (row.expiresAt.getTime() <= Date.now()) return deny
  if (row.username.toLowerCase() !== input.username.trim().toLowerCase()) return deny

  const presented = Buffer.from(hashSecret(input.secret), 'hex')
  const stored = Buffer.from(row.secretHash, 'hex')
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return deny

  // Best-effort device-activity stamp; a failure must never fail the mount.
  void touchDriveCredentialLastUsed(row.id).catch(() => {})

  return { allow: true, userId: row.userId, organizationId: row.organizationId }
}
