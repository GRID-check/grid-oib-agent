/**
 * Receiving one mail (Worker → BFF, ADR-0074): verify it, stage its
 * attachments, queue it, answer. Filing happens later, in `./drain`.
 *
 * ## Why accept and file are two steps
 *
 * The Worker holds the sender's SMTP transaction open while this runs, and a
 * mail of a hundred files through `uploadDocument` does not fit in that window.
 * So the webhook does only what decides the answer, stores the selected
 * attachments, and says 202; the scheduler's tick drains the queue.
 *
 * ## The order of work, and why it is this order
 *
 *  1. Parse the recipient. Our domain or not is a config question (retry).
 *  2. Resolve the token under the platform bypass, BEFORE reading the body: an
 *     unknown address costs a header and an index lookup, nothing more.
 *  3. The organization's `project-mail-inbox` switch.
 *  4. A process-wide slot for a large mail (at most two at once, else 503),
 *     taken on the DECLARED size before a byte is read, so concurrent large
 *     deliveries cannot each buffer 26 MiB before one of them is turned away.
 *     No declared size counts as large; a small declaration caps the read at
 *     the slot threshold, so a wrong header cannot slip a big body past it.
 *  5. Read the body under that cap, refusing a declared size over the maximum
 *     up front.
 *  6. Verify the sender, find them in THIS organization's roster, check they
 *     may write documents in THIS project.
 *  7. Parse the mail and select its attachments.
 *  8. The delivery key; a mail already queued, filing or filed is a duplicate
 *     and costs nothing more.
 *  9. The rate limits, after the dedupe, so a redelivery is never refused.
 * 10. Stage the selected attachments under the project's prefix.
 * 11. Queue the row.
 * 12. 202.
 *
 * ## The answer is a contract
 *
 * A permanent refusal carries `x-inbound-verdict: reject` and is the ONLY
 * answer the Worker bounces (`./contract`). Everything else is retried by the
 * sending server: a DNS temperror, a WorkOS blip, a database outage, a rate
 * limit, a busy parser, a misconfigured domain.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { ApiError, NotFoundError, PayloadTooLargeError } from '@/lib/api/errors'
import { errorResponse, readBoundedBody } from '@/lib/api/handler'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { TransientAuthzError } from '@/lib/authz/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { SkippedAttachment } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { enforceLimit, INBOUND_MAIL_ADDRESS_LIMIT, INBOUND_MAIL_ORG_LIMIT } from '@/lib/limits'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { asciiLower, inboundMailDomain, parseInboundAddress } from './address'
import {
  INBOUND_ENVELOPE_TO_HEADER,
  INBOUND_RAW_SIZE_HEADER,
  INBOUND_VERDICT_HEADER,
  INBOUND_VERDICT_REJECT,
} from './contract'
import { mailFolderName } from './folder-name'
import { deliveryKey, parseMail } from './mime'
import { findActiveAddressByToken, findDelivery, queueDelivery, type ResolvedAddress } from './repository'
import { verifySender } from './sender-auth'
import { deleteStagedObjects, errorName, stageAttachments } from './staging'
import type { ParsedMail } from './types'

/** Envoy's and the Worker's ceiling on one message, in raw bytes. */
export const MAX_MESSAGE_BYTES = 26 * 1024 * 1024

/** A mail may carry at most this many files; the rest are skipped as `limit`. */
export const MAX_FILES_PER_MAIL = 100

/** A message at least this big parses under {@link MAX_CONCURRENT_LARGE_PARSES}. */
export const LARGE_MESSAGE_BYTES = 1024 * 1024

/** Large parses one BFF process runs at once; one more is a 503 and a retry. */
export const MAX_CONCURRENT_LARGE_PARSES = 2

/** Skipped parts that keep their name on the row; the rest keep only a reason. */
const MAX_NAMED_SKIPS = 100

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

type RefusalOutcome =
  | 'refused-address'
  | 'refused-disabled'
  | 'refused-size'
  | 'refused-sender'
  | 'refused-member'
  | 'refused-permission'

type Outcome = 'accepted' | 'duplicate' | RefusalOutcome | `retry-${string}`

/**
 * A permanent refusal: the one error the response marks with the reject
 * verdict. Three texts for six reasons, so the answer enumerates nothing a
 * stranger could learn from (an address switched off reads as unknown).
 */
export class InboundMailRefusal extends ApiError {
  constructor(readonly outcome: RefusalOutcome) {
    const [status, code, message] = REFUSALS[outcome]
    super(status, code, message)
  }
}

const SENDER_REFUSED = 'Sender is not permitted to file mail into this project'
const REFUSALS: Record<RefusalOutcome, [number, string, string]> = {
  'refused-address': [404, 'NOT_FOUND', 'Unknown address'],
  'refused-disabled': [404, 'NOT_FOUND', 'Unknown address'],
  'refused-size': [413, 'PAYLOAD_TOO_LARGE', `The message exceeds ${MAX_MESSAGE_BYTES / (1024 * 1024)} MiB`],
  'refused-sender': [403, 'FORBIDDEN', SENDER_REFUSED],
  'refused-member': [403, 'FORBIDDEN', SENDER_REFUSED],
  'refused-permission': [403, 'FORBIDDEN', SENDER_REFUSED],
}

/** What one delivery did, for its one log line. No names, no addresses, no subject. */
interface Trail {
  outcome: Outcome
  addressId: string | null
  rowId: string | null
  files: number
  skipped: number
  error: string | null
}

/**
 * A refusal the sending server should retry: no verdict header. Named so the
 * log line says which retry it was.
 */
class InboundMailRetry extends ApiError {
  readonly outcome: `retry-${string}`
  constructor(reason: string, status: number, code: string, message: string) {
    super(status, code, message)
    this.outcome = `retry-${reason}`
  }
}

function retry(reason: string, status: number, code: string, message: string): InboundMailRetry {
  return new InboundMailRetry(reason, status, code, message)
}

function outcomeOf(error: unknown): Outcome {
  if (error instanceof InboundMailRefusal || error instanceof InboundMailRetry) return error.outcome
  if (error instanceof TransientAuthzError) return `retry-authz`
  if (error instanceof ApiError) return error.status === 429 ? 'retry-limit' : `retry-${error.status}`
  return 'retry-error'
}

// ---------------------------------------------------------------------------
// The route's entry point
// ---------------------------------------------------------------------------

export interface ReceiveOptions {
  /** For tests: DNS for sender verification. */
  resolver?: NonNullable<Parameters<typeof verifySender>[1]>['resolver']
  now?: Date
}

/**
 * Answer one delivery. Never throws: every outcome is a response, and every
 * response logs exactly one line.
 */
export async function receiveInboundMail(request: Request, options: ReceiveOptions = {}): Promise<Response> {
  const started = Date.now()
  const trail: Trail = { outcome: 'retry-error', addressId: null, rowId: null, files: 0, skipped: 0, error: null }
  try {
    const accepted = await acceptDelivery(request, trail, options)
    return Response.json(accepted.body, { status: accepted.status })
  } catch (error) {
    trail.outcome = outcomeOf(error)
    return refusalOrRetry(error, request, trail)
  } finally {
    logDelivery(trail, Date.now() - started)
  }
}

function refusalOrRetry(error: unknown, request: Request, trail: Trail): Response {
  if (error instanceof ApiError) {
    const response = errorResponse(error, request)
    if (error instanceof InboundMailRefusal) response.headers.set(INBOUND_VERDICT_HEADER, INBOUND_VERDICT_REJECT)
    return response
  }
  // Never hand the error object to a logger: a drizzle error's message carries
  // the query's parameters. Its class and code are enough to find it.
  trail.error = errorName(error)
  return errorResponse(new ApiError(503, 'INBOUND_MAIL_UNAVAILABLE', 'Try again later'), request)
}

function logDelivery(trail: Trail, ms: number): void {
  const line =
    `[inbound-mail] outcome=${trail.outcome} address=${trail.addressId ?? '-'} row=${trail.rowId ?? '-'} ` +
    `files=${trail.files} skipped=${trail.skipped} ms=${ms}` +
    (trail.error ? ` error=${trail.error}` : '')
  if (trail.outcome === 'accepted' || trail.outcome === 'duplicate') {
    // The operator trail (D-7): one INFO line per delivery, which the container
    // log collector keeps. WARN would file every accepted mail as a problem.
    // eslint-disable-next-line no-console
    console.info(line)
  } else if (trail.outcome.startsWith('refused-')) console.warn(line)
  else console.error(line)
}

// ---------------------------------------------------------------------------
// Steps 1-5: the address, the switch, the body
// ---------------------------------------------------------------------------

interface Accepted {
  status: 200 | 202
  body: { status: 'queued' | 'duplicate'; files?: number; skipped?: number }
}

/** Step 1. A domain that is unset or not ours is our fault, so it is a retry. */
export function tokenForRecipient(envelopeTo: string | null): string {
  const domain = inboundMailDomain()
  const parsed = domain && envelopeTo ? parseInboundAddress(envelopeTo, domain) : { kind: 'foreign' as const }
  if (parsed.kind === 'token') return parsed.token
  if (parsed.kind === 'malformed') throw new InboundMailRefusal('refused-address')
  throw retry('config', 503, 'INBOUND_MAIL_MISCONFIGURED', 'The inbound mail domain is not configured here')
}

async function acceptDelivery(request: Request, trail: Trail, options: ReceiveOptions): Promise<Accepted> {
  const token = tokenForRecipient(request.headers.get(INBOUND_ENVELOPE_TO_HEADER))
  const address = await withPlatformAccess(
    'inbound mail: the address token names the project before any organization is known',
    () => findActiveAddressByToken(token)
  )
  if (!address) throw new InboundMailRefusal('refused-address')
  trail.addressId = address.addressId

  return withTenant({ organizationId: address.organizationId }, async () => {
    if (!(await isProjectMailInboxEnabledForOrg(address.organizationId))) {
      throw new InboundMailRefusal('refused-disabled')
    }
    const declared = declaredSize(request)
    return withParseSlot(declared, async () => {
      const raw = await readMessage(request, declared)
      return acceptMessage({ address, token, raw, trail, options })
    })
  })
}

/** The Worker's `x-inbound-raw-size`, or null when absent or not a size. */
function declaredSize(request: Request): number | null {
  const header = request.headers.get(INBOUND_RAW_SIZE_HEADER)
  const value = header === null ? Number.NaN : Number(header)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Step 5. The size header is a claim, so the stream is capped as well: at the
 * maximum for a large or undeclared mail, at the slot threshold for a mail that
 * declared itself small. A small declaration with a bigger body is a Worker
 * bug, not the sender's doing, so it is retried rather than bounced.
 */
async function readMessage(request: Request, declared: number | null): Promise<Uint8Array> {
  if (declared !== null && declared > MAX_MESSAGE_BYTES) throw new InboundMailRefusal('refused-size')
  const small = declared !== null && declared < LARGE_MESSAGE_BYTES
  try {
    return await readBoundedBody(request, small ? LARGE_MESSAGE_BYTES : MAX_MESSAGE_BYTES)
  } catch (error) {
    if (!(error instanceof PayloadTooLargeError)) throw error
    if (small) throw retry('size-mismatch', 503, 'INBOUND_MAIL_SIZE_MISMATCH', 'The body exceeds its declared size.')
    throw new InboundMailRefusal('refused-size')
  }
}

let largeParses = 0

/**
 * Step 4: a counter, not a queue. A mail that finds both slots taken is
 * retried. `declared` is null when the Worker sent no size: that counts as large.
 */
async function withParseSlot<T>(declared: number | null, run: () => Promise<T>): Promise<T> {
  if (declared !== null && declared < LARGE_MESSAGE_BYTES) return run()
  if (largeParses >= MAX_CONCURRENT_LARGE_PARSES) {
    throw retry('busy', 503, 'INBOUND_MAIL_BUSY', 'Too many large messages at once. Try again shortly.')
  }
  largeParses += 1
  try {
    return await run()
  } finally {
    largeParses -= 1
  }
}

// ---------------------------------------------------------------------------
// Steps 6-12: the sender, the mail, the queue
// ---------------------------------------------------------------------------

interface Delivery {
  address: ResolvedAddress
  token: string
  raw: Uint8Array
  trail: Trail
  options: ReceiveOptions
}

async function acceptMessage(delivery: Delivery): Promise<Accepted> {
  const { address, trail } = delivery
  const sender = await authorizeSender(delivery)
  const mail = await parseMail(delivery.raw, { maxFiles: MAX_FILES_PER_MAIL })
  trail.files = mail.attachments.length
  trail.skipped = mail.skipped.length

  const key = deliveryKey(mail.messageId, mail.attachments.map((attachment) => attachment.sha256))
  const existing = await findDelivery(address.addressId, key)
  if (existing && existing.status !== 'failed') {
    trail.rowId = existing.id
    trail.outcome = 'duplicate'
    return { status: 200, body: { status: 'duplicate' } }
  }

  await enforceLimit(INBOUND_MAIL_ADDRESS_LIMIT, `${address.organizationId}:${address.addressId}`)
  await enforceLimit(INBOUND_MAIL_ORG_LIMIT, address.organizationId)
  return queueMail(delivery, sender, mail, key)
}

interface AuthorizedSender {
  session: AuthorizedSession
  fromAddress: string
  fromName: string | null
}

/** Step 6. Verified, a member of THIS organization, a writer in THIS project. */
async function authorizeSender(delivery: Delivery): Promise<AuthorizedSender> {
  const { address } = delivery
  const verdict = await verifySender(delivery.raw, { projectToken: delivery.token, resolver: delivery.options.resolver })
  if (verdict.verdict === 'temperror') throw retry('temperror', 503, 'SENDER_TEMPERROR', 'Try again later')
  if (verdict.verdict === 'fail') throw new InboundMailRefusal('refused-sender')

  const person = await findMemberByEmail(address.organizationId, verdict.fromAddress)
  if (!person) throw new InboundMailRefusal('refused-member')
  const session = await resolvePinnedRequesterSession(
    { userId: person.userId, email: person.email, organizationId: address.organizationId },
    { onError: 'throw' }
  )
  if (!session) throw new InboundMailRefusal('refused-member')

  await requireDocumentWrite(session, address.projectId)
  return { session, fromAddress: verdict.fromAddress, fromName: verdict.fromName }
}

/**
 * The member of `organizationId` whose email is `email`, from that
 * organization's roster and no other. Compared with ASCII-only lowercasing,
 * so no Unicode case fold can make two addresses meet.
 *
 * An empty roster is not an answer: every organization with a project has at
 * least one member, and the directory reports a failed WorkOS read as an empty
 * map. So it is a 503 and the sending server retries.
 */
async function findMemberByEmail(organizationId: string, email: string): Promise<DirectoryPerson | null> {
  const directory = await loadOrganizationDirectory(organizationId)
  if (directory.size === 0) {
    throw retry('directory', 503, 'DIRECTORY_UNAVAILABLE', 'The member directory could not be read. Try again later.')
  }
  const wanted = asciiLower(email.trim())
  for (const person of directory.values()) {
    if (person.email && asciiLower(person.email.trim()) === wanted) return person
  }
  return null
}

/**
 * The gate `uploadDocument` applies, asked up front with the same function, so
 * the webhook and the filing cannot disagree. Asked with `onError: 'throw'`:
 * an FGA check that could not complete is a {@link TransientAuthzError} (503,
 * retried), and only a definite "no" becomes a permanent refusal.
 */
async function requireDocumentWrite(session: AuthorizedSession, projectId: string): Promise<void> {
  try {
    await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'], { onError: 'throw' })
  } catch (error) {
    if (error instanceof NotFoundError) throw new InboundMailRefusal('refused-permission')
    throw error
  }
}

/** Steps 10-12. A staging that does not end up named by a queued row is deleted. */
async function queueMail(
  delivery: Delivery,
  sender: AuthorizedSender,
  mail: ParsedMail,
  key: string
): Promise<Accepted> {
  const { address, trail } = delivery
  const id = randomUUID()
  const receivedAt = delivery.options.now ?? new Date()
  const staging = await stageAttachments({ ...address, deliveryId: id }, mail.attachments)
  let rowId: string | null = null
  try {
    rowId = await queueDelivery({
      ...address,
      id,
      deliveryKey: key,
      senderUserId: sender.session.userId,
      folderName: mailFolderName(receivedAt, { name: sender.fromName ?? mail.fromName, address: sender.fromAddress }),
      subject: mail.subject,
      stagingBucket: staging.bucket,
      staged: staging.staged,
      skipped: boundSkipped(mail.skipped),
      receivedAt,
    })
  } finally {
    if (!rowId) await deleteStagedObjects(staging.bucket, staging.staged)
  }
  if (!rowId) {
    // Another delivery of this mail queued it between the lookup and here.
    trail.outcome = 'duplicate'
    return { status: 200, body: { status: 'duplicate' } }
  }
  trail.rowId = rowId
  trail.outcome = 'accepted'
  return { status: 202, body: { status: 'queued', files: mail.attachments.length, skipped: mail.skipped.length } }
}

/** Every skip is counted; only the first {@link MAX_NAMED_SKIPS} keep a name on the row. */
function boundSkipped(skipped: ParsedMail['skipped']): SkippedAttachment[] {
  return skipped.map(({ filename, reason }, index) => (index < MAX_NAMED_SKIPS ? { filename, reason } : { reason }))
}
