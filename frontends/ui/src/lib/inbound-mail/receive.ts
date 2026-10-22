/**
 * Receiving one mail: the webhook the Cloudflare Email Worker posts each
 * message to (ADR-0135, `POST /api/internal/signed/inbound-mail`). It decides
 * the answer, streams the raw message to staging and queues the job that reads
 * it. It parses nothing, and it can file nothing: a mail is only ever HELD here
 * (`review-first.spec.ts` keeps every filing module out of its imports).
 *
 * ## The order of work (DECISION §6, Receive), and why it is this order
 *
 *  1. The RFC 9421 signature, by the route factory, before this runs: method,
 *     URL, body digest and length, and both envelope headers are bound to a
 *     key we hold, so nothing below acts on a header anyone could rewrite.
 *  2. The pause switch (`GRID_INBOUND_MAIL_PAUSED`): 503, the sender retries.
 *  3. The envelope headers, decoded (`decodeEnvelopeAddress`). A malformed
 *     escape is the Worker's bug, never the sender's: 400 without a verdict.
 *  4. The token, resolved under the platform bypass (ids only). Unknown: 404
 *     with the reject verdict, after a charge to a bucket of its own, so a
 *     guesser walking the token space never spends real mail's budget.
 *  5. The organization's scope, then its `inbound-mail` flag, read from WorkOS
 *     so that a failed lookup is a 503 (retry), never an "off" that bounces.
 *  6. The signed length against the largest message: 413 with the verdict.
 *  7. The rate limits (per signing key, organization, address) and the byte
 *     caps on what is staged (per address, per organization): 429, retried.
 *     All of it before a byte of the body is read.
 *  8. The `receiving` row, naming the bucket and the exact key first (ADR-0043).
 *  9. The body streamed to `raw.eml`, counted and hashed as it flows
 *     (`streamBodyTo`) and kept for the delivery key.
 * 10. The byte count must EQUAL the signed length and the bytes must hash to
 *     the signed digest: a short body is a 503 `body-truncated` (retried), a
 *     tampered one a 401 (`bad-digest`).
 * 11. The delivery key (`deliveryKey`: the authored headers and the body, so a
 *     relay's prepended lines do not make a redelivery new). A mail this
 *     address already holds answers 200 and its second copy is erased.
 * 12. `received` and the receive job, in one transaction.
 * 13. 202.
 *
 * ## The answer is a contract (`shared/inbound-mail-contract.json`)
 *
 * The Worker bounces a mail ONLY on a 4xx carrying `x-inbound-verdict: reject`:
 * an unknown or revoked address, an office with the feature off (the same
 * text, so a bounce teaches a guesser nothing), a message too large. Every
 * other answer makes it throw, and the sending server retries for days: a
 * pause, a store or database outage, a limit, a cut body, our own
 * misconfiguration. A closed project holds its mail (RT-X13).
 *
 * One PII-free log line per delivery (ids, sizes, the outcome code), and a
 * PostHog event for a refusal. Never a sender, a subject or an address: the
 * token in the recipient is a secret too.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { ApiError, BadRequestError, PayloadTooLargeError, ServiceUnavailableError } from '@/lib/api/errors'
import { BadDigestError, BodyOverlongError, BodyTruncatedError, streamBodyTo } from '@/lib/api/bounded-body'
import { errorResponse } from '@/lib/api/handler'
import { captureServer } from '@/lib/analytics/posthog-server'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import type { VerifiedSignature } from '@/lib/internal-auth'
import { enforceLimit } from '@/lib/limits/enforce'
import {
  INBOUND_MAIL_ADDRESS_LIMIT,
  INBOUND_MAIL_ORGANIZATION_LIMIT,
  INBOUND_MAIL_SIGNING_KEY_LIMIT,
  INBOUND_MAIL_UNKNOWN_ADDRESS_LIMIT,
} from '@/lib/limits/catalog'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { inboundMailDomain, parseInboundAddress } from './address'
import {
  decodeEnvelopeAddress,
  ENVELOPE_FROM_HEADER,
  ENVELOPE_TO_HEADER,
  MAX_RAW_MESSAGE_BYTES,
  REJECT_TEXT,
  VERDICT_HEADER,
  VERDICT_REJECT,
} from './contract'
import { INBOUND_MAIL_WAIT_DAYS, inboundMailStagingKey } from './inbound-mail-vocabulary'
import { deliveryKey } from './mime'
import {
  completeReception,
  findActiveAddressByToken,
  findMailIdByDeliveryKey,
  forgetReceptionObject,
  insertReception,
  stagedBytes,
  type ResolvedInboundAddress,
} from './repository'
import { eraseStagedObjects, putRawMessage, stagingBucketFor } from './staging'

/** Raw bytes staged per address at most (D18): a leaked address fills its own cap, never the office's. */
export const INBOUND_MAIL_ADDRESS_STAGED_BYTES = 1024 * 1024 * 1024

/** Raw bytes staged per organization at most (D18). */
export const INBOUND_MAIL_ORGANIZATION_STAGED_BYTES = 5 * 1024 * 1024 * 1024

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What one delivery came to. English codes for the log line and PostHog's
 * `inbound_mail_refused.reason`; the operator's alerts match on them
 * (`kubernetes.md` §3c).
 */
export type DeliveryOutcomeCode =
  | 'accepted'
  | 'duplicate'
  | 'unknown_address'
  | 'switched_off'
  | 'too_large'
  | 'rate_limited'
  | 'cap_reached'
  | 'paused'
  | 'bad_envelope'
  | 'misconfigured'
  | 'body_truncated'
  | 'body_overlong'
  | 'bad_digest'
  | 'unavailable'

/** The outcomes that count as a refusal in PostHog (the sender's server bounced or will retry). */
const REFUSALS: ReadonlySet<DeliveryOutcomeCode> = new Set([
  'unknown_address',
  'switched_off',
  'too_large',
  'rate_limited',
  'cap_reached',
  'paused',
  'bad_envelope',
  'misconfigured',
  'body_truncated',
  'body_overlong',
  'bad_digest',
  'unavailable',
])

/**
 * A permanent refusal: the only error the answer marks with the reject
 * verdict, and the only one the Worker bounces. One text for every reason
 * ({@link REJECT_TEXT}): an address switched off reads as unknown.
 */
export class InboundMailRejectedError extends ApiError {
  constructor(readonly outcome: Extract<DeliveryOutcomeCode, 'unknown_address' | 'switched_off' | 'too_large'>) {
    super(outcome === 'too_large' ? 413 : 404, outcome === 'too_large' ? 'PAYLOAD_TOO_LARGE' : 'NOT_FOUND', REJECT_TEXT)
  }
}

/** A refusal the sending server retries: no verdict, a code for the log. */
class InboundMailRetryError extends ServiceUnavailableError {
  constructor(readonly outcome: Extract<DeliveryOutcomeCode, 'paused' | 'misconfigured' | 'unavailable'>, message: string) {
    super(message, { reason: outcome })
  }
}

/** Over a byte cap: 429 without a verdict, so the mail waits at the sender until mail is filed or expires. */
class StagedBytesCapError extends ApiError {
  readonly outcome = 'cap_reached' as const
  constructor() {
    super(429, 'RATE_LIMITED', 'Too much mail is waiting for this address', { reason: 'cap-reached' })
  }
}

/** Whether the deployment's pause switch is on (`GRID_INBOUND_MAIL_PAUSED`, Pulumi `inboundMailPaused`). */
export function inboundMailPaused(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.GRID_INBOUND_MAIL_PAUSED ?? '').trim().toLowerCase() === 'true'
}

/** What one delivery did, for its one log line: ids, sizes and codes, never a name or an address. */
interface Trail {
  outcome: DeliveryOutcomeCode
  organizationId: string | null
  addressId: string | null
  mailId: string | null
  bytes: number
  error: string | null
}

export interface ReceiveContext {
  request: Request
  signature: VerifiedSignature
}

/**
 * Answer one delivery. Never throws: every outcome is a response, and every
 * response logs exactly one line.
 */
export async function receiveInboundMail(context: ReceiveContext, now: () => Date = () => new Date()): Promise<Response> {
  const started = Date.now()
  const trail: Trail = { outcome: 'unavailable', organizationId: null, addressId: null, mailId: null, bytes: 0, error: null }
  try {
    const answer = await acceptDelivery(context, trail, now)
    return Response.json({ status: answer.outcome }, { status: answer.outcome === 'duplicate' ? 200 : 202 })
  } catch (error) {
    return refusalResponse(error, context.request, trail)
  } finally {
    logDelivery(trail, Date.now() - started)
  }
}

/** The response for a refusal, marked with the verdict only when it is one the Worker may bounce. */
function refusalResponse(error: unknown, request: Request, trail: Trail): Response {
  trail.outcome = outcomeOf(error)
  // Never hand an unknown error to the logger or the client: a database
  // error's message carries the statement's parameters (the envelope sender).
  const known = error instanceof ApiError ? error : new InboundMailRetryError('unavailable', 'Try again later')
  if (!(error instanceof ApiError)) trail.error = errorName(error)
  const response = errorResponse(known, request)
  if (known instanceof InboundMailRejectedError) response.headers.set(VERDICT_HEADER, VERDICT_REJECT)
  if (REFUSALS.has(trail.outcome)) {
    captureServer({
      event: 'inbound_mail_refused',
      distinctId: null,
      organizationId: trail.organizationId,
      properties: { reason: trail.outcome },
    })
  }
  return response
}

function outcomeOf(error: unknown): DeliveryOutcomeCode {
  if (error instanceof InboundMailRejectedError || error instanceof InboundMailRetryError) return error.outcome
  if (error instanceof StagedBytesCapError) return 'cap_reached'
  if (error instanceof BodyTruncatedError) return 'body_truncated'
  if (error instanceof BodyOverlongError) return 'body_overlong'
  if (error instanceof BadDigestError) return 'bad_digest'
  if (error instanceof ApiError && error.status === 429) return 'rate_limited'
  if (error instanceof BadRequestError) return 'bad_envelope'
  if (error instanceof PayloadTooLargeError) return 'too_large'
  return 'unavailable'
}

/** The class and code of an error, never its message. */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = 'code' in error && typeof error.code === 'string' ? `:${error.code}` : ''
  return `${error.name}${code}`
}

function logDelivery(trail: Trail, ms: number): void {
  const line =
    `[inbound-mail] delivery outcome=${trail.outcome} org=${trail.organizationId ?? '-'} ` +
    `address=${trail.addressId ?? '-'} mail=${trail.mailId ?? '-'} bytes=${trail.bytes} ms=${ms}` +
    (trail.error ? ` error=${trail.error}` : '')
  if (trail.outcome === 'accepted' || trail.outcome === 'duplicate') {
    // oxlint-disable-next-line no-console -- the per-delivery INFO line is the operator's trail
    console.info(line)
  } else if (trail.outcome === 'unavailable' || trail.outcome === 'misconfigured') console.error(line)
  else console.warn(line)
}

// ---------------------------------------------------------------------------
// Steps 2-13
// ---------------------------------------------------------------------------

interface Envelope {
  token: string
  /** The SMTP MAIL FROM, decoded; `''` for the null reverse-path of a bounce. */
  from: string
}

/** Steps 2 and 3: the pause, then the envelope, decoded and parsed. */
function readEnvelope(request: Request): Envelope {
  if (inboundMailPaused()) throw new InboundMailRetryError('paused', 'Receiving mail is paused')
  const toHeader = request.headers.get(ENVELOPE_TO_HEADER)
  const fromHeader = request.headers.get(ENVELOPE_FROM_HEADER)
  if (toHeader === null || fromHeader === null) {
    throw new BadRequestError('The envelope headers are missing', { reason: 'bad-envelope' })
  }
  let to: string
  let from: string
  try {
    to = decodeEnvelopeAddress(toHeader)
    from = decodeEnvelopeAddress(fromHeader)
  } catch {
    // A malformed %-escape: the Worker never writes one. No verdict, so the sender retries.
    throw new BadRequestError('An envelope header is not encoded as agreed', { reason: 'bad-envelope' })
  }
  const domain = inboundMailDomain()
  if (!domain) throw new InboundMailRetryError('misconfigured', 'This deployment receives no mail')
  const recipient = parseInboundAddress(to, domain)
  // Cloudflare routes only our domain to the Worker: another one is our configuration, not the sender.
  if (recipient.kind === 'foreign') throw new InboundMailRetryError('misconfigured', 'The recipient is not in our domain')
  if (recipient.kind === 'malformed') throw new UnknownTokenError()
  return { token: recipient.token, from }
}

/** A recipient that names no project: charged to its own bucket, then rejected. */
class UnknownTokenError extends Error {}

async function acceptDelivery(
  { request, signature }: ReceiveContext,
  trail: Trail,
  now: () => Date,
): Promise<{ outcome: 'accepted' | 'duplicate' }> {
  let address: ResolvedInboundAddress | null = null
  let envelope: Envelope | null = null
  try {
    envelope = readEnvelope(request)
    const token = envelope.token
    address = await withPlatformAccess('inbound mail: the address token names the project before any organization is known', () =>
      findActiveAddressByToken(token),
    )
  } catch (error) {
    if (!(error instanceof UnknownTokenError)) throw error
  }
  if (!address || !envelope) {
    await enforceLimit(INBOUND_MAIL_UNKNOWN_ADDRESS_LIMIT, `keyid:${signature.keyId}`)
    throw new InboundMailRejectedError('unknown_address')
  }
  const resolved = address
  const sender = envelope.from
  trail.organizationId = resolved.organizationId
  trail.addressId = resolved.addressId
  return withTenant({ organizationId: resolved.organizationId }, () => acceptForAddress(request, signature, resolved, sender, trail, now))
}

/** Steps 5-13, inside the organization's scope. */
async function acceptForAddress(
  request: Request,
  signature: VerifiedSignature,
  address: ResolvedInboundAddress,
  envelopeFrom: string,
  trail: Trail,
  now: () => Date,
): Promise<{ outcome: 'accepted' | 'duplicate' }> {
  await requireFeature(address.organizationId)
  const length = signature.contentLength
  if (length > MAX_RAW_MESSAGE_BYTES) throw new InboundMailRejectedError('too_large')
  await enforceLimits(signature, address, length)

  const mailId = randomUUID()
  trail.mailId = mailId
  trail.bytes = length
  const owner = { organizationId: address.organizationId, projectId: address.projectId }
  const bucket = await stagingBucketFor(address.organizationId)
  const key = inboundMailStagingKey(owner, mailId, 'raw.eml')
  const receivedAt = now()
  await insertReception({
    id: mailId,
    ...owner,
    addressId: address.addressId,
    envelopeFrom: envelopeFrom.slice(0, 320),
    rawSizeBytes: length,
    stagingBucket: bucket,
    rawStorageKey: key,
    receivedAt,
    expiresAt: new Date(receivedAt.getTime() + INBOUND_MAIL_WAIT_DAYS * DAY_MS),
  })

  const raw = await stageRawMessage(request, signature, bucket, key, mailId)
  const delivery = deliveryKey(raw)
  const held = await findMailIdByDeliveryKey(address.addressId, delivery)
  const outcome = held
    ? 'duplicate'
    : await completeReception({ mailId, ...owner, deliveryKey: delivery, rawSizeBytes: length })
  if (outcome === 'duplicate') {
    // The mail is held already (a sender's retry after a lost answer, a replay):
    // its second copy goes, and the row is swept as a reception that ended.
    await discardReception(bucket, key, mailId)
    trail.outcome = 'duplicate'
    return { outcome: 'duplicate' }
  }
  trail.outcome = 'accepted'
  return { outcome: 'accepted' }
}

/** Step 5: the office's `inbound-mail` entitlement. A lookup that fails is a 503, never an "off" that bounces. */
async function requireFeature(organizationId: string): Promise<void> {
  let featureFlags: string[]
  try {
    featureFlags = await enabledFlagsForOrganization(organizationId)
  } catch {
    throw new InboundMailRetryError('unavailable', 'The office’s settings could not be read')
  }
  if (!isFeatureEnabled({ featureFlags }, FEATURE_FLAGS.inboundMail)) throw new InboundMailRejectedError('switched_off')
}

/** Step 7: the rate limits, then the byte caps, all before the body is read. */
async function enforceLimits(signature: VerifiedSignature, address: ResolvedInboundAddress, length: number): Promise<void> {
  await enforceLimit(INBOUND_MAIL_SIGNING_KEY_LIMIT, `keyid:${signature.keyId}`)
  await enforceLimit(INBOUND_MAIL_ORGANIZATION_LIMIT, address.organizationId)
  await enforceLimit(INBOUND_MAIL_ADDRESS_LIMIT, `${address.organizationId}:${address.addressId}`)
  const staged = await stagedBytes(address.organizationId, address.addressId)
  if (staged.address + length > INBOUND_MAIL_ADDRESS_STAGED_BYTES) throw new StagedBytesCapError()
  if (staged.organization + length > INBOUND_MAIL_ORGANIZATION_STAGED_BYTES) throw new StagedBytesCapError()
}

/**
 * Steps 9 and 10: the body to `raw.eml` as it streams, held to the signed
 * length and digest, and kept for the delivery key (at most 26 MiB, the
 * Worker's own buffer). A refusal or a store fault erases what was written and
 * leaves the row for the sweep.
 */
async function stageRawMessage(
  request: Request,
  signature: VerifiedSignature,
  bucket: string,
  key: string,
  mailId: string,
): Promise<Uint8Array> {
  const length = signature.contentLength
  try {
    return await streamBodyTo(
      request,
      { expectedLength: length, maxBytes: MAX_RAW_MESSAGE_BYTES, contentDigest: signature.contentDigest },
      async (body) => {
        const [toStore, toKeep] = body.tee()
        const [, bytes] = await Promise.all([storeRaw(bucket, key, toStore, length), collect(toKeep, length)])
        return bytes
      },
    )
  } catch (error) {
    await discardReception(bucket, key, mailId)
    throw error
  }
}

/** The upload; a store fault is a 503 the sender retries. A body refusal is the stream's own error. */
async function storeRaw(bucket: string, key: string, body: ReadableStream<Uint8Array>, length: number): Promise<void> {
  try {
    await putRawMessage(bucket, key, body, length)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new InboundMailRetryError('unavailable', 'Object storage is unavailable')
  }
}

/** Every byte of `body`, at most `length` of them (the meter refuses more before they arrive here). */
async function collect(body: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length)
  let offset = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return offset === length ? bytes : bytes.subarray(0, offset)
    bytes.set(value.subarray(0, Math.max(0, length - offset)), offset)
    offset += value.byteLength
  }
}

/** Erase a reception's object by its key and stop naming it. Best effort: sweep 1 finishes what this cannot. */
async function discardReception(bucket: string, key: string, mailId: string): Promise<void> {
  try {
    const left = await eraseStagedObjects(bucket, [key])
    if (left.length === 0) await forgetReceptionObject(mailId)
  } catch (error) {
    console.warn(`[inbound-mail] reception ${mailId} left for the sweep: ${errorName(error)}`)
  }
}
