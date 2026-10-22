/**
 * Shared guards for INTERNAL service endpoints.
 *
 * Two shapes, one fail-closed rule set:
 *
 *   - **A shared token** (`requireInternalToken`), for callers inside the
 *     cluster (backend → BFF): `GRID_INTERNAL_API_TOKEN` in the
 *     `x-grid-internal-token` header. The well-known dev default is refused
 *     outside dev environments; an unconfigured token disables the endpoint.
 *   - **A signed request** (`requireInternalSignature`), for a caller outside
 *     the cluster that pushes bytes in: RFC 9421 HTTP Message Signatures over
 *     the method, the target URI, the RFC 9530 `Content-Digest` and the
 *     `Content-Length`, HMAC-SHA256 under a keyid. A bearer token proves only
 *     who sent the request; a signature also proves which body, for which URL,
 *     and when. The verification is the maintained library's
 *     (`http-message-signatures`, "buy, don't build"); this module decides
 *     which keys, which components and which lifetimes it accepts.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createVerifier, ExpiredError, httpbis, type VerifyingKey } from 'http-message-signatures'
import { isInnerList, parseDictionary, Token, type BareItem } from 'structured-headers'
import { ApiError, ServiceUnavailableError } from '@/lib/api/errors'
import { configuredAppOrigin } from '@/lib/app-origin'

export const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

/**
 * Which secret a route checks. The service token authorizes backend → BFF
 * calls (memory writes among them); a credential handed to something outside
 * the cluster gets its own, so leaking it opens exactly one route.
 */
export type InternalTokenEnv = 'GRID_INTERNAL_API_TOKEN' | 'GRID_CORPUS_EXPORT_TOKEN'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether this process runs in a dev environment, where the well-known dev
 * secrets are allowed. `APP_ENV` is "production" on every deployed stack, dev
 * ones included, so only a local process answers yes.
 */
export function isDevEnvironment(): boolean {
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production').toLowerCase()
  return DEV_APP_ENVS.has(env)
}

/**
 * The secret `tokenEnv` names, or null when it must not be used: unset, or the
 * well-known dev default outside a dev environment. For a key DERIVED from it
 * (an HMAC over a domain label), the same fail-closed rule the guard below
 * applies to the token itself.
 */
export function usableInternalSecret(tokenEnv: InternalTokenEnv = 'GRID_INTERNAL_API_TOKEN'): string | null {
  const secret = process.env[tokenEnv]
  if (!secret) return null
  if (secret === DEV_DEFAULT_TOKEN && !isDevEnvironment()) return null
  return secret
}

/**
 * Returns a rejection Response, or null when the request is authorized.
 * Usage: `const denied = requireInternalToken(request); if (denied) return denied`
 */
export function requireInternalToken(
  request: Request,
  label: string,
  tokenEnv: InternalTokenEnv = 'GRID_INTERNAL_API_TOKEN'
): Response | null {
  const expectedToken = process.env[tokenEnv]
  if (!expectedToken) {
    console.error(`[${label}] ${tokenEnv} is not configured — rejecting`)
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (expectedToken === DEV_DEFAULT_TOKEN && !isDevEnvironment()) {
    console.error(
      `[${label}] ${tokenEnv} is the well-known dev default in a non-dev environment — refusing to serve.`,
    )
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (!tokensMatch(request.headers.get(INTERNAL_TOKEN_HEADER), expectedToken)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

// ---------------------------------------------------------------------------
// Signed requests (RFC 9421 + RFC 9530)
// ---------------------------------------------------------------------------

/**
 * Which key map a signed route checks. One variable per caller, so rotating or
 * leaking one caller's keys touches exactly its routes.
 *
 * The value is a JSON object from keyid to a base64 secret of at least
 * {@link MIN_SIGNING_SECRET_BYTES} bytes, with at most {@link MAX_SIGNING_KEYS}
 * entries: `{"mi-2026-10":"<openssl rand -base64 32>"}`.
 */
export type SigningKeysEnv = 'GRID_INBOUND_MAIL_SIGNING_KEYS'

/** The one algorithm accepted (RFC 9421 §3.3.3). The secret is shared, so no key pair to manage. */
export const SIGNATURE_ALGORITHM = 'hmac-sha256'

/**
 * Components every signed request covers, whatever its route adds.
 *
 * `content-digest` binds the bytes and `content-length` their count, so the
 * body cannot be swapped or cut under a captured signature; `@target-uri`
 * binds the route, so a signature for one endpoint is not one for another.
 */
export const REQUIRED_COVERED_COMPONENTS = ['@method', '@target-uri', 'content-digest', 'content-length'] as const

/**
 * The longest a signature may live, `expires - created`, in seconds.
 *
 * There is no nonce store (DECISION D19): within this window a replay is the
 * same bytes, and the route answers the same bytes idempotently. A signature
 * that names a longer window is refused rather than trimmed, because a signer
 * asking for more is a misconfigured signer.
 */
export const MAX_SIGNATURE_LIFETIME_S = 300

/** How far in the future `created` may lie: the clock skew tolerated between signer and us. */
export const MAX_CLOCK_SKEW_S = 30

/** Two keys at once: the old one and its successor, for an overlap rotation. Never a third. */
export const MAX_SIGNING_KEYS = 2

/** An HMAC-SHA256 key shorter than its output is weaker than the hash (RFC 2104 §3). */
export const MIN_SIGNING_SECRET_BYTES = 32

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The well-known secret local stacks sign with. Like the dev token it is in the
 * repository, so it is refused outside a dev environment.
 */
export const DEV_DEFAULT_SIGNING_SECRET = Buffer.from('grid-internal-dev-signing-secret').toString('base64')

/** Why a signed request was refused. The code is what the operator's alert matches on. */
export type SignatureRefusal =
  /** No `Signature` / `Signature-Input`. */
  | 'unsigned'
  /** Not exactly one parseable signature, a required component or parameter missing, a lifetime too long. */
  | 'malformed'
  /** `expires` has passed, or `created` lies too far in the future. */
  | 'expired'
  /** The keyid is not in the key map: never issued, or rotated out. */
  | 'unknown-key'
  /** Everything parsed and the MAC does not match. */
  | 'bad-signature'

/** What a verified signature vouches for. The body checks in `@/lib/api/bounded-body` hold the bytes to it. */
export interface VerifiedSignature {
  readonly keyId: string
  readonly created: Date
  readonly expires: Date
  /** The signed `Content-Length`: the exact number of bytes the body must have. */
  readonly contentLength: number
  /** The signed RFC 9530 `Content-Digest` field value the body must hash to. */
  readonly contentDigest: string
}

export interface SignatureRequirement {
  readonly keysEnv: SigningKeysEnv
  /**
   * Components this route needs covered beyond {@link REQUIRED_COVERED_COMPONENTS},
   * lower-case field names such as `x-envelope-to`. A header the route acts on
   * and the signature does not cover is a header anyone could rewrite.
   */
  readonly components?: readonly string[]
}

/** A 401 the factory maps to the error envelope; `details.reason` carries the refusal code. */
export class SignatureRefusedError extends ApiError {
  constructor(readonly reason: SignatureRefusal) {
    super(401, 'UNAUTHORIZED', 'Request signature refused', { reason })
  }
}

/**
 * The key map `keysEnv` names, or null when signed requests must be refused.
 *
 * Every defect disables the route rather than some of its keys, because a
 * partly readable key map is a configuration nobody meant: unset, not JSON,
 * empty, more than {@link MAX_SIGNING_KEYS} keys, a keyid outside
 * `[A-Za-z0-9._-]{1,64}`, a secret that is not base64 or shorter than
 * {@link MIN_SIGNING_SECRET_BYTES} bytes, or the dev default outside dev.
 */
export function usableSigningKeys(keysEnv: SigningKeysEnv, label: string): ReadonlyMap<string, Buffer> | null {
  const raw = process.env[keysEnv]
  if (!raw) return disabled(label, `${keysEnv} is not configured`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return disabled(label, `${keysEnv} is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return disabled(label, `${keysEnv} is not an object of keyid to secret`)
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0 || entries.length > MAX_SIGNING_KEYS) {
    return disabled(label, `${keysEnv} holds ${entries.length} keys; 1 or ${MAX_SIGNING_KEYS} are accepted`)
  }
  const keys = new Map<string, Buffer>()
  for (const [keyId, secret] of entries) {
    const problem = signingKeyProblem(keyId, secret)
    if (problem) return disabled(label, `${keysEnv} key ${KEY_ID_PATTERN.test(keyId) ? keyId : '(invalid id)'}: ${problem}`)
    keys.set(keyId, Buffer.from(secret as string, 'base64'))
  }
  return keys
}

function signingKeyProblem(keyId: string, secret: unknown): string | null {
  if (!KEY_ID_PATTERN.test(keyId)) return 'the keyid must match [A-Za-z0-9._-]{1,64}'
  if (typeof secret !== 'string' || !BASE64_PATTERN.test(secret)) return 'the secret must be base64'
  if (Buffer.from(secret, 'base64').length < MIN_SIGNING_SECRET_BYTES) {
    return `the secret must be at least ${MIN_SIGNING_SECRET_BYTES} bytes`
  }
  if (secret === DEV_DEFAULT_SIGNING_SECRET && !isDevEnvironment()) {
    return 'the well-known dev secret is refused outside a dev environment'
  }
  return null
}

function disabled(label: string, why: string): null {
  console.error(`[${label}] signed requests disabled: ${why}`)
  return null
}

/**
 * Verify the request's RFC 9421 signature, before any database work and before
 * a byte of the body is read (DECISION §4, A2). Throws {@link SignatureRefusedError}
 * (401) or a 503 when the key map is unusable; returns what the signature
 * vouches for, which the body readers then hold the bytes to.
 *
 * Exactly one signature is accepted. RFC 9421 lets a message carry several,
 * and the library then lets the last one with a known key decide; one is all
 * a single signer sends, and anything else is refused as malformed.
 */
export async function requireInternalSignature(
  request: Request,
  label: string,
  requirement: SignatureRequirement,
): Promise<VerifiedSignature> {
  const keys = usableSigningKeys(requirement.keysEnv, label)
  if (!keys) throw new ServiceUnavailableError('Internal API disabled')
  try {
    return await verifySignature(request, keys, requirement)
  } catch (error) {
    if (error instanceof SignatureRefusedError) {
      // Codes and the keyid only: the alert reads the reason, nothing personal is in it.
      console.warn(`[${label}] request signature refused reason=${error.reason}`)
    }
    throw error
  }
}

async function verifySignature(
  request: Request,
  keys: ReadonlyMap<string, Buffer>,
  requirement: SignatureRequirement,
): Promise<VerifiedSignature> {
  const signatureInput = request.headers.get('signature-input')
  if (!signatureInput || !request.headers.get('signature')) throw new SignatureRefusedError('unsigned')
  const params = signatureParameters(signatureInput)
  // The library reads the clock itself, so this does too: one notion of now.
  const nowS = Math.floor(Date.now() / 1000)
  if (params.created > nowS + MAX_CLOCK_SKEW_S || params.expires < nowS) throw new SignatureRefusedError('expired')
  const secret = keys.get(params.keyId)
  if (!secret) throw new SignatureRefusedError('unknown-key')

  const contentLength = signedContentLength(request)
  const contentDigest = request.headers.get('content-digest')
  if (contentDigest === null) throw new SignatureRefusedError('malformed')

  const key: VerifyingKey = { id: params.keyId, algs: [SIGNATURE_ALGORITHM], verify: createVerifier(secret, SIGNATURE_ALGORITHM) }
  let verified: boolean | null
  try {
    verified = await httpbis.verifyMessage(
      {
        keyLookup: async ({ keyid }) => (keyid === params.keyId ? key : null),
        requiredParams: ['created', 'expires', 'keyid', 'alg'],
        requiredFields: [...REQUIRED_COVERED_COMPONENTS, ...(requirement.components ?? [])],
        // The window was checked above; these repeat it inside the library, so
        // the two can only disagree by being stricter.
        notAfter: nowS + MAX_CLOCK_SKEW_S,
        maxAge: MAX_SIGNATURE_LIFETIME_S + MAX_CLOCK_SKEW_S,
      },
      { method: request.method, url: trustedTargetUri(request), headers: headerRecord(request) },
    )
  } catch (error) {
    throw new SignatureRefusedError(error instanceof ExpiredError ? 'expired' : 'malformed')
  }
  if (verified !== true) throw new SignatureRefusedError('bad-signature')
  return {
    keyId: params.keyId,
    created: new Date(params.created * 1000),
    expires: new Date(params.expires * 1000),
    contentLength,
    contentDigest,
  }
}

interface SignatureParameters {
  readonly keyId: string
  readonly created: number
  readonly expires: number
}

/**
 * The parameters of the request's one signature, checked before the library
 * runs: exactly one signature, `alg="hmac-sha256"`, a keyid, and integer
 * `created` and `expires` no more than {@link MAX_SIGNATURE_LIFETIME_S} apart.
 */
function signatureParameters(signatureInput: string): SignatureParameters {
  let inputs: ReturnType<typeof parseDictionary>
  try {
    inputs = parseDictionary(signatureInput)
  } catch {
    throw new SignatureRefusedError('malformed')
  }
  const [only, ...rest] = [...inputs.values()]
  if (!only || rest.length > 0 || !isInnerList(only)) throw new SignatureRefusedError('malformed')
  const parameters = only[1]
  const keyId = parameters.get('keyid')
  const created = parameters.get('created')
  const expires = parameters.get('expires')
  if (typeof keyId !== 'string' || !isInteger(created) || !isInteger(expires)) {
    throw new SignatureRefusedError('malformed')
  }
  if (bareText(parameters.get('alg')) !== SIGNATURE_ALGORITHM) throw new SignatureRefusedError('malformed')
  const lifetime = expires - created
  if (lifetime <= 0 || lifetime > MAX_SIGNATURE_LIFETIME_S) throw new SignatureRefusedError('malformed')
  return { keyId, created, expires }
}

function isInteger(value: BareItem | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function bareText(value: BareItem | undefined): string | null {
  if (typeof value === 'string') return value
  return value instanceof Token ? value.toString() : null
}

/**
 * The signed `Content-Length`, which must be a plain decimal. A request
 * without one (a chunked body) cannot be held to an exact length, so it is
 * refused rather than read.
 */
function signedContentLength(request: Request): number {
  const raw = request.headers.get('content-length')
  if (raw === null || !/^\d{1,15}$/.test(raw)) throw new SignatureRefusedError('malformed')
  return Number(raw)
}

/**
 * `@target-uri` as the signer meant it: the deployment's pinned origin plus
 * the path and query this request arrived on.
 *
 * `request.url` is rebuilt from the inbound Host header and whatever scheme
 * the hop in front of Node reported, and TLS ends at the gateway, so it can
 * read `http://` for a request the signer sent to `https://`. The pinned
 * origin (`configuredAppOrigin`) is the one the signer is configured with; a
 * signer posting to another origin fails with `bad-signature`, loudly.
 */
function trustedTargetUri(request: Request): string {
  const url = new URL(request.url)
  return `${configuredAppOrigin() ?? url.origin}${url.pathname}${url.search}`
}

function headerRecord(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries())
}
