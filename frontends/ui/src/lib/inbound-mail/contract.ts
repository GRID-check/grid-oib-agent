/**
 * The transport contract of project mail (ADR-0134, ADR-0135): what the
 * Cloudflare Email Worker and the webhook agree on, and the closed vocabularies
 * the transport modules of this folder produce.
 *
 * Pure and client-safe: no `server-only`, no database, no parser. The webhook,
 * the receive job, the drizzle schema (through `./inbound-mail-vocabulary`),
 * the wire module and the review UI all read the same tuples from here, and the
 * Worker, which is plain JavaScript outside this package, is held to the same
 * values by `shared/inbound-mail-contract.json` (`contract.spec.ts` here,
 * `inbound-mail-worker.spec.ts` there).
 *
 * Every token is English; what a person reads for one lives in the i18n
 * dictionaries.
 */

// ---------------------------------------------------------------------------
// The Worker ↔ webhook contract
// ---------------------------------------------------------------------------

/**
 * Where the Worker posts. Under `/api/internal/signed/`, which the Next proxy
 * does not match, so the body is never buffered before its signature is
 * checked (ADR-0134 D20).
 */
export const INBOUND_MAIL_WEBHOOK_PATH = '/api/internal/signed/inbound-mail'

/** The envelope recipient (RFC 5321 RCPT TO) the Worker was invoked for. */
export const ENVELOPE_TO_HEADER = 'x-envelope-to'

/**
 * The envelope sender (RFC 5321 MAIL FROM), `NULL_SENDER` for a null reverse-path. Both envelope headers carry
 * every UTF-8 byte outside 0x21–0x7E, and `%`, as `%XX` (shared/inbound-mail-contract.json `envelopeEncoding`).
 */
export const ENVELOPE_FROM_HEADER = 'x-envelope-from'

/**
 * The envelope sender header for a null reverse-path, RFC 5321's own spelling. An empty header value is
 * fragile across Envoy and the signature library, so the Worker never sends one.
 */
export const NULL_SENDER = '<>'

/**
 * An envelope header as the Worker wrote it, back to the SMTP address (`''` for the null sender). Throws a
 * `URIError` on a malformed escape, which the Worker never writes: the route answers it 400 without the
 * verdict, so the sender retries.
 */
export function decodeEnvelopeAddress(header: string): string {
  return header === NULL_SENDER ? '' : decodeURIComponent(header)
}

/**
 * The Worker bounces a mail ONLY when the answer is a 4xx carrying
 * `x-inbound-verdict: reject`. Any other answer, a 4xx without it included,
 * makes it throw so the sending server retries: a misrouted URL, a proxy's 404
 * or a paused deployment can never bounce a member's mail.
 */
export const VERDICT_HEADER = 'x-inbound-verdict'
export const VERDICT_REJECT = 'reject'

/**
 * The largest message the webhook accepts, 26 MiB. The Worker can buffer
 * 25 MiB at most (Workers Paid), so the bound is never what refuses a mail
 * Cloudflare delivered; it is what the database's `raw_size_bytes` CHECK and
 * the Envoy per-route limit (27 MiB, above it) are written against.
 */
export const MAX_RAW_MESSAGE_BYTES = 26 * 1024 * 1024

/**
 * The RFC 9421 components the Worker signs, in order: the request line, the
 * RFC 9530 digest and length of the fixed-length body, and both envelope
 * headers, so a replayed signature cannot be pointed at another project.
 */
export const SIGNED_COMPONENTS = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-length',
  ENVELOPE_TO_HEADER,
  ENVELOPE_FROM_HEADER,
] as const

/** `expires − created` of every signature, in seconds. */
export const SIGNATURE_LIFETIME_SECONDS = 300

/**
 * The one bounce text, ASCII, naming no reason: an unknown token, a deleted
 * project and an office that switched the feature off read the same, so a
 * bounce teaches a guesser nothing (ADR-0134 D5).
 */
export const REJECT_TEXT =
  'This message could not be delivered: the address is unknown or no longer valid. ' +
  'Help: https://piloti.at/e-mail-eingang/ Privacy: https://piloti.at/datenschutz/'

/** What the Worker does with the webhook's answer. */
export type DeliveryOutcome = 'accepted' | 'rejected' | 'retry'

/** The Worker's reading of an answer, written once so both sides run the same cases. */
export function deliveryOutcome(status: number, verdict: string | null): DeliveryOutcome {
  if (status >= 200 && status < 300) return 'accepted'
  if (status >= 400 && status < 500 && verdict === VERDICT_REJECT) return 'rejected'
  return 'retry'
}

// ---------------------------------------------------------------------------
// The vocabularies the transport modules produce
// ---------------------------------------------------------------------------

/**
 * The closed vocabularies `./sender-auth`, `./mime` and `./automatic-mail`
 * produce: sender trust and its reason, the sender flags, an attachment's risk
 * flags, why a part was not staged, why a mail was dropped. Declared once
 * beside the CHECKs that hold them (`./inbound-mail-vocabulary`, migration
 * 0186) and re-exported here, so the transport modules and the Worker contract
 * read as one module.
 */
export {
  DROPPED_REASONS,
  INBOUND_SENDER_TRUSTS,
  NOT_STAGED_REASONS,
  PART_RISK_FLAGS,
  SENDER_FLAGS,
  SENDER_REASONS,
  type DroppedReason,
  type InboundSenderTrust,
  type NotStagedReason,
  type PartRiskFlag,
  type SenderFlag,
  type SenderReason,
} from './inbound-mail-vocabulary'
