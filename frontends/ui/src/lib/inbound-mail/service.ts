/**
 * The project mail inbox (ADR-0074): the project's address, and filing a mail
 * that arrived at it.
 *
 * ## The one upload path
 *
 * A mail is filed AS its sender. The From address is verified
 * (`./sender-auth`), matched against the roster of the organization the
 * address belongs to — that organization only — and turned into the session
 * that person would have if they were signed in (`resolvePinnedRequesterSession`).
 * Every attachment then goes through `uploadDocument`, exactly as a drag onto
 * the file list would: permission, type allowlist, size, quota, versioning,
 * audit and ingest all come from there (ADR-0055). Its refusals become
 * per-file skip reasons; they never fail the mail.
 *
 * ## Tenancy
 *
 * The route resolves the token under the platform bypass and hands this module
 * the three ids it learned, inside `withTenant` for that organization. Nothing
 * here reads or writes outside it.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InsufficientStorageError,
  NotFoundError,
  PayloadTooLargeError,
} from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import { withTenant } from '@/lib/db/tenant-context'
import { uploadDocument } from '@/lib/documents/service'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { enforceLimit, INBOUND_MAIL_ADDRESS_LIMIT, INBOUND_MAIL_ORG_LIMIT } from '@/lib/limits'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import {
  formatInboundAddress,
  inboundMailDomain,
  mintToken,
  parseInboundAddress,
  projectSlug,
} from './address'
import type { InboundAddressResponse, RotateInboundAddressResponse } from './contract'
import { mailFolderPath } from './folder-name'
import { parseMail, type MailFile, type SkippedPart, type SkipReason } from './mime'
import {
  claimMessage,
  findActiveAddressForProject,
  insertAddress,
  markMessageFailed,
  markMessageFiled,
  rotateAddress,
  type NewAddress,
  type ResolvedAddress,
} from './repository'
import type { InboundMailAddressRow } from '@/lib/db/schema'
import { verifySender, type VerifySenderOptions } from './sender-auth'

/** The Cloudflare Email Worker's own cap on a message. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024

/** A mail may carry at most this many files; the rest are skipped as `limit`. */
export const MAX_FILES_PER_MAIL = 100

/** Tries at minting a token that does not collide (60 bits: one is plenty). */
const MINT_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// The project's address (UI → BFF)
// ---------------------------------------------------------------------------

/**
 * The project's address, minted on first read.
 *
 * Requires document write access (`project:documents:write` any-of
 * `project:edit`, the same pair `uploadDocument` asks for): an address is only
 * worth showing to somebody whose mail it would accept.
 */
export async function getInboundAddress(
  session: AuthorizedSession,
  projectId: string
): Promise<InboundAddressResponse> {
  const { role } = await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])
  // `project-admin` is the rung `requireProjectAccess` derives from holding
  // `project:manage` (or the org-wide bypass) — the permission rotation checks.
  const canRotate = role === 'project-admin'
  const domain = inboundMailDomain()
  if (!domain) return { enabled: false, address: null, canRotate }

  const row =
    (await findActiveAddressForProject(session.organizationId, projectId)) ??
    (await mintAddress(session, projectId, 'lazy'))
  return { enabled: true, address: formatInboundAddress(row.slug, row.token, domain), canRotate }
}

/** Revoke the project's address and mint a new one. Requires `project:manage`. */
export async function rotateInboundAddress(
  session: AuthorizedSession,
  projectId: string
): Promise<RotateInboundAddressResponse> {
  await requireProjectAccess(session, projectId, 'project:manage')
  const domain = inboundMailDomain()
  if (!domain) throw new NotFoundError('Inbound mail is not enabled')
  const row = await mintAddress(session, projectId, 'rotate')
  return { address: formatInboundAddress(row.slug, row.token, domain) }
}

async function mintAddress(
  session: AuthorizedSession,
  projectId: string,
  mode: 'lazy' | 'rotate'
): Promise<InboundMailAddressRow> {
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const input: NewAddress = {
      organizationId: session.organizationId,
      projectId,
      token: mintToken(),
      slug: projectSlug(project.name),
      createdBy: session.userId,
    }
    const result =
      mode === 'rotate' ? await rotateAddress({ ...input, revokedBy: session.userId }) : await insertAddress(input)
    if (result.ok) return result.row
    if (result.conflict === 'token') continue
    // A concurrent request gave the project its active address first.
    const winner = await findActiveAddressForProject(session.organizationId, projectId)
    if (winner && mode === 'lazy') return winner
    if (mode === 'rotate') throw new ConflictError('The address was rotated concurrently. Try again.')
  }
  throw new ConflictError('Could not mint a project mail address. Try again.')
}

// ---------------------------------------------------------------------------
// Receiving (Worker → BFF)
// ---------------------------------------------------------------------------

/**
 * The token the envelope recipient names, or a 404 for anything that is not
 * one of ours — a foreign domain, a malformed address, the feature switched off.
 */
export function tokenForRecipient(envelopeTo: string | null): string {
  const domain = inboundMailDomain()
  const token = domain && envelopeTo ? parseInboundAddress(envelopeTo, domain) : null
  if (!token) throw new NotFoundError('Unknown address')
  return token
}

/**
 * The request body, refused with a 413 the moment it passes `limit` rather
 * than after all of it has been buffered.
 */
export async function readRawMessage(request: Request, limit: number = MAX_MESSAGE_BYTES): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit)
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new PayloadTooLargeError(limit)
    }
    chunks.push(value)
  }
  const raw = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.byteLength
  }
  return raw
}

export interface InboundMailResult {
  status: 'filed'
  filed: number
  skipped: SkippedPart[]
  duplicate?: true
}

export interface ReceiveOptions {
  /** For tests: DNS for sender verification. */
  senderAuth?: VerifySenderOptions
  now?: Date
}

/**
 * File one delivery to one address. Runs inside `withTenant` for the address's
 * organization; the caller opened it.
 *
 * 403 for a sender who is not verified, not a member of THIS organization, or
 * lacks document write on THIS project — one message for all three, so the
 * answer enumerates nothing. 429 when a budget is spent, 409 while another
 * delivery of the same mail is being filed; both make the sending server retry.
 */
export async function receiveInboundMail(
  address: ResolvedAddress,
  raw: Uint8Array,
  request: Request,
  options: ReceiveOptions = {}
): Promise<InboundMailResult> {
  const sender = await authorizeSender(address, raw, options.senderAuth)

  await enforceLimit(INBOUND_MAIL_ADDRESS_LIMIT, `${address.organizationId}:${address.addressId}`)
  await enforceLimit(INBOUND_MAIL_ORG_LIMIT, address.organizationId)

  const mail = await parseMail(raw)
  const claim = await claimMessage({ ...address, messageIdHash: messageHash(mail.messageId, raw) }, options.now)
  if (claim.kind === 'duplicate') {
    return { status: 'filed', filed: claim.filedCount, skipped: [], duplicate: true }
  }
  if (claim.kind === 'busy') throw new ConflictError('This message is being filed by another delivery')

  return withTenant({ organizationId: address.organizationId, userId: sender.session.userId }, async () => {
    try {
      const result = await fileMail(address, sender, mail, request, options.now ?? new Date())
      await markMessageFiled(claim.messageRowId, {
        senderUserId: sender.session.userId,
        filedCount: result.filed,
        skippedCount: result.skipped.length,
      })
      await notifySender(address, sender, mail.subject, claim.messageRowId, result)
      return { status: 'filed' as const, filed: result.filed, skipped: result.skipped }
    } catch (error) {
      await markMessageFailed(claim.messageRowId).catch((markError: unknown) => {
        console.error('[inbound-mail] could not mark a failed delivery:', markError)
      })
      throw error
    }
  })
}

interface AuthorizedSender {
  session: AuthorizedSession
  person: DirectoryPerson
  fromAddress: string
}

const SENDER_REFUSED = 'Sender is not permitted to file mail into this project'

/** Verify the From header, find the person in THIS organization, check THIS project. */
async function authorizeSender(
  address: ResolvedAddress,
  raw: Uint8Array,
  senderAuth: VerifySenderOptions | undefined
): Promise<AuthorizedSender> {
  const verdict = await verifySender(raw, senderAuth)
  if (!verdict.verified) {
    console.warn(`[inbound-mail] refused unverified sender for address ${address.addressId}: ${verdict.reason}`)
    throw new ForbiddenError(SENDER_REFUSED)
  }

  const person = await findMemberByEmail(address.organizationId, verdict.fromAddress)
  if (!person) throw new ForbiddenError(SENDER_REFUSED)

  const session = await resolvePinnedRequesterSession({
    userId: person.userId,
    email: person.email,
    organizationId: address.organizationId,
  })
  if (!session) throw new ForbiddenError(SENDER_REFUSED)

  // The same any-of `uploadDocument` enforces, asked up front so a viewer's
  // mail is refused as a whole instead of skipping every file one by one.
  const mayWrite =
    (await userHoldsProjectPermission(session, address.projectId, person.userId, 'project:documents:write')) ||
    (await userHoldsProjectPermission(session, address.projectId, person.userId, 'project:edit'))
  if (!mayWrite) throw new ForbiddenError(SENDER_REFUSED)

  return { session, person, fromAddress: verdict.fromAddress }
}

/**
 * The member of `organizationId` whose email is `email`, from that
 * organization's roster and no other.
 *
 * An empty roster is not an answer: every organization with a project has at
 * least one member, and the directory reports a failed WorkOS read as an empty
 * map. Refusing on it would bounce a member's mail permanently for a hiccup, so
 * it is a 503 and the sending server retries.
 */
async function findMemberByEmail(organizationId: string, email: string): Promise<DirectoryPerson | null> {
  const directory = await loadOrganizationDirectory(organizationId)
  if (directory.size === 0) {
    throw new ApiError(503, 'DIRECTORY_UNAVAILABLE', 'The member directory could not be read. Try again later.')
  }
  for (const person of directory.values()) {
    if (person.email?.trim().toLowerCase() === email) return person
  }
  return null
}

/** sha256 of the Message-ID, or of the raw bytes when there is none. */
export function messageHash(messageId: string | null, raw: Uint8Array): string {
  const hash = createHash('sha256')
  if (messageId) hash.update(messageId, 'utf8')
  else hash.update(raw)
  return hash.digest('hex')
}

interface FilingResult {
  filed: number
  skipped: SkippedPart[]
  folderId: string | null
}

async function fileMail(
  address: ResolvedAddress,
  sender: AuthorizedSender,
  mail: Awaited<ReturnType<typeof parseMail>>,
  request: Request,
  receivedAt: Date
): Promise<FilingResult> {
  const skipped: SkippedPart[] = [...mail.skipped]
  const files = mail.files.slice(0, MAX_FILES_PER_MAIL)
  for (const extra of mail.files.slice(MAX_FILES_PER_MAIL)) skipped.push({ filename: extra.filename, reason: 'limit' })
  if (files.length === 0) return { filed: 0, skipped, folderId: null }

  const path = mailFolderPath({
    subject: mail.subject,
    dateHeader: mail.dateHeader,
    receivedAt,
    senderName: mail.fromName,
    senderAddress: sender.fromAddress,
  })
  const folders = await ensureProjectFolderPaths(
    { projectId: address.projectId, parentId: null, paths: [path] },
    sender.session
  )
  const folderId = folders.ok ? folders.folderIdByPath[path] : undefined
  if (!folderId) throw new Error(`[inbound-mail] could not create the mail folder: ${folders.ok ? path : folders.error}`)

  let filed = 0
  for (const file of files) {
    const reason = await uploadOne(sender.session, address.projectId, folderId, file, request)
    if (reason) skipped.push({ filename: file.filename, reason })
    else filed += 1
  }
  return { filed, skipped, folderId }
}

/** File one attachment; `null` when it landed, else why it did not. */
async function uploadOne(
  session: AuthorizedSession,
  projectId: string,
  folderId: string,
  file: MailFile,
  request: Request
): Promise<SkipReason | null> {
  try {
    const body = new File([file.bytes], file.filename, { type: file.mimeType })
    await uploadDocument(session, { projectId, folderId, file: body }, request)
    return null
  } catch (error) {
    const reason = refusalReason(error)
    // Anything that is not a refusal about THIS file — storage down, the
    // database gone — fails the delivery so the sending server retries it.
    if (!reason) throw error
    return reason
  }
}

/** Translate an `uploadDocument` refusal into a skip reason; `null` for a real failure. */
export function refusalReason(error: unknown): SkipReason | null {
  if (error instanceof InsufficientStorageError) return 'quota'
  if (error instanceof BadRequestError) {
    const details = error.details
    if (details && typeof details === 'object' && 'maxSizeBytes' in details) return 'size'
    return 'type'
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return 'rejected'
  }
  return null
}

/** Tell the sender, in their inbox, what became of their mail. Never fails the mail. */
async function notifySender(
  address: ResolvedAddress,
  sender: AuthorizedSender,
  subject: string | undefined,
  messageRowId: string,
  result: FilingResult
): Promise<void> {
  try {
    const project = await findProjectInOrg(address.projectId, address.organizationId)
    await emitInboxItems([
      {
        organizationId: address.organizationId,
        recipientUserId: sender.session.userId,
        type: 'inbound_mail.filed',
        resourceType: 'project',
        resourceId: address.projectId,
        anchorId: messageRowId,
        // A system item: the recipient is the one who sent it, and an emission
        // whose actor is its recipient is dropped as self-notification.
        actorUserId: null,
        groupKey: inboxGroupKey('inbound_mail.filed', 'project', address.projectId, messageRowId),
        payload: {
          subject: subject?.trim() || '(ohne Betreff)',
          folderId: result.folderId,
          params: {
            filed: result.filed,
            skipped: result.skipped.length,
            project: project?.name ?? '',
          },
        },
      },
    ])
  } catch (error) {
    console.warn('[inbound-mail] could not notify the sender:', error)
  }
}
