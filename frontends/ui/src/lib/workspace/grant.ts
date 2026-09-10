/**
 * The mount grant: how a mount made in the MIDDLE of a turn reaches the
 * knowledge layer (ADR-0054, spec MT-6).
 *
 * A turn's retrieval scope is fixed when the WebSocket connection is upgraded —
 * the BFF builds it, signs it into the request-context envelope, and the Python
 * side trusts that copy (ADR-0047). `open_project` happens after that: the
 * agent decides mid-answer that it needs Seestadt's documents, and the scope it
 * was handed does not contain them. Re-upgrading the connection is not
 * available to a tool, and letting the tool WIDEN the scope by naming a
 * collection would hand the model the naming authority the BFF holds (ADR-0006)
 * — a prompt-injected "read proj_<uuid>" would then be a read.
 *
 * So the mounts endpoint mints this: a short-lived, signed statement that THIS
 * conversation, in THIS organisation, may read THIS collection until `exp`. The
 * tool carries it back into the turn, and the knowledge layer unions it into the
 * scope only after verifying the signature. The authority still belongs to the
 * BFF; the grant is how it reaches the middle of a turn.
 *
 * ## No new trust boundary
 *
 * The secret is `GRID_INTERNAL_API_TOKEN` and the MAC is the one
 * `signGridRequestContextEnvelope` already computes for the request-context
 * envelope — the same shared secret, the same HMAC-SHA256 over the same kind of
 * payload, verified on the Python side with the same constant-time comparison.
 * A second signing scheme would have been a second thing to get wrong.
 *
 * ## Why the payload is built key by key
 *
 * The wire contract fixes the key ORDER (`v, collection, shelf, projectId,
 * projectName, conversationId, organizationId, exp`). Verification does not
 * depend on it — the MAC is over the bytes the verifier decodes, whatever order
 * they are in — but a fixture on either side does, and a payload assembled from
 * a spread of an interface is one refactor away from a different order. So the
 * JSON is written out here, once, in the order the contract states.
 */

import 'server-only'
import { signGridRequestContextEnvelope } from '@/lib/request-context'

/** How long a grant is good for. Long enough for a turn, short enough that a
 * revoked permission cannot be replayed past the next upgrade (spec MT-7). */
export const MOUNT_GRANT_TTL_SECONDS = 900

/** The version of the payload shape. Python refuses anything but 1. */
export const MOUNT_GRANT_VERSION = 1

/** What a grant says. Exactly the fields the knowledge layer checks. */
export interface MountGrant {
  v: typeof MOUNT_GRANT_VERSION
  /** `proj_<uuid>` — from `projects.collection_name`, never re-derived. */
  collection: string
  shelf: 'project'
  projectId: string
  projectName: string
  conversationId: string
  organizationId: string
  /** Epoch SECONDS, not milliseconds — the unit `exp` carries everywhere. */
  exp: number
}

/** The grant as it travels: the payload, and the MAC over its exact bytes. */
export interface WireGrant {
  /** `base64url(JSON.stringify(payload))`. */
  grant: string
  /**
   * `hex(HMAC-SHA256(payloadJson, GRID_INTERNAL_API_TOKEN))`, or `''` when the
   * deployment has no token configured.
   *
   * The empty string is the deliberate dev-only mirror of what the request
   * envelope already does: with no shared secret there is nothing to verify
   * against, and the Python side skips verification in exactly that case
   * (`project_context.py`). It is not a fail-open in production — a deployment
   * without the token has no internal endpoints either, because
   * `internalApiRoute` fails closed without it.
   */
  sig: string
}

/** The payload JSON, in the contract's key order. */
function encodeGrantPayload(grant: MountGrant): string {
  return JSON.stringify({
    v: grant.v,
    collection: grant.collection,
    shelf: grant.shelf,
    projectId: grant.projectId,
    projectName: grant.projectName,
    conversationId: grant.conversationId,
    organizationId: grant.organizationId,
    exp: grant.exp,
  })
}

export interface MintMountGrantInput {
  collection: string
  projectId: string
  projectName: string
  conversationId: string
  organizationId: string
  /** Injectable so a test can pin expiry; defaults to now. */
  now?: Date
}

/**
 * Mint a signed, short-lived grant for one mounted project.
 *
 * `exp` is computed from `now` at mint time rather than read back from the row:
 * a mount persisted an hour ago is still a valid mount, but the GRANT for it is
 * a fresh one every time the endpoint answers, so an old response body can
 * never be replayed into a later turn.
 */
export function mintMountGrant(input: MintMountGrantInput): WireGrant {
  const issuedAt = input.now ?? new Date()
  const grant: MountGrant = {
    v: MOUNT_GRANT_VERSION,
    collection: input.collection,
    shelf: 'project',
    projectId: input.projectId,
    projectName: input.projectName,
    conversationId: input.conversationId,
    organizationId: input.organizationId,
    exp: Math.floor(issuedAt.getTime() / 1000) + MOUNT_GRANT_TTL_SECONDS,
  }
  const json = encodeGrantPayload(grant)
  const secret = process.env.GRID_INTERNAL_API_TOKEN
  return {
    grant: Buffer.from(json, 'utf8').toString('base64url'),
    sig: secret ? signGridRequestContextEnvelope(json, secret) : '',
  }
}

/**
 * Verify and decode a wire grant — the near-side twin of what the knowledge
 * layer does, so the two halves of the contract can be tested against one
 * another in this repo rather than only in production.
 *
 * Returns null on every failure, and deliberately gives no reason to the
 * caller: a grant that does not verify widens nothing, and the distinction
 * between "tampered" and "expired" belongs in a log line, not in a return type
 * some caller might switch on.
 */
export function verifyMountGrant(
  wire: WireGrant,
  options: { now?: Date; secret?: string | null } = {}
): MountGrant | null {
  const secret = options.secret === undefined ? process.env.GRID_INTERNAL_API_TOKEN : options.secret
  let json: string
  try {
    json = Buffer.from(wire.grant, 'base64url').toString('utf8')
  } catch {
    return null
  }

  if (secret) {
    const expected = signGridRequestContextEnvelope(json, secret)
    // Length-safe comparison: `timingSafeEqual` throws on unequal lengths, and
    // a hex MAC of the wrong length is a refusal, not an exception.
    if (wire.sig.length !== expected.length || !constantTimeEquals(wire.sig, expected)) return null
  }

  const parsed: unknown = safeParse(json)
  if (!isMountGrant(parsed)) return null
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (parsed.exp <= nowSeconds) return null
  return parsed
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

/** Does this parsed payload claim everything a grant must claim? */
function isMountGrant(value: unknown): value is MountGrant {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.v === MOUNT_GRANT_VERSION &&
    candidate.shelf === 'project' &&
    typeof candidate.collection === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.projectName === 'string' &&
    typeof candidate.conversationId === 'string' &&
    typeof candidate.organizationId === 'string' &&
    typeof candidate.exp === 'number' &&
    Number.isFinite(candidate.exp)
  )
}
