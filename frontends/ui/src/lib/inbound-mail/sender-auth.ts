/**
 * Who a mail is from, as far as its bytes and DNS can tell, and what that
 * means for the defaults a person sees (ADR-0134 D4, check B2).
 *
 * Every mail is held whatever this says. The verdict is a label and a
 * condition on defaults (thread pre-selection, following, the acknowledgements
 * a decision needs), never a gate on acceptance. DKIM proves a domain, not a
 * person, so `verified` never means more than "the From domain signed this".
 *
 * ## Two halves
 *
 * - {@link authenticateSender} reads the bytes and DNS. Cloudflare Email
 *   Routing hands the Worker no SPF, DKIM or DMARC verdict and no connecting
 *   IP, so the BFF decides from the raw message with mailauth 8
 *   `authenticate()`, called without an `ip`. Its `spf` result is therefore
 *   always `temperror` and is never read: the evidence line is built from the
 *   DKIM and DMARC results alone ({@link evidenceLine}). DMARC's own verdict is
 *   evidence too, never a condition, because without SPF an aligned DKIM pass
 *   is the whole DMARC pass we can compute.
 * - {@link judgeSender} is pure: the facts, the directory's answer for the From
 *   address and the receipt time give the trust label, the flags and the send
 *   time the receive job stores, clamped by the thread core's `clampSentAt`
 *   (one clamp for the flag, the heading and the thread order).
 *
 * ## Verified
 *
 * One DKIM signature that mailauth reports as `pass` and aligned with the
 * single From domain (DMARC alignment, RFC 9989, relaxed unless the domain's
 * record says strict), and that also:
 *
 * 1. covers the whole body: no `l=` tag, which lets anyone append below it;
 * 2. comes from a key not in testing mode (`t=y`, RFC 6376 §3.6.1);
 * 3. has not expired (`x=`);
 * 4. signs From, Subject, Message-ID and Date: the Message-ID is the dedupe
 *    and thread key, the Date the replay window;
 * 5. is not rsa-sha1 and its key has at least 1024 bits (RFC 8301; mailauth
 *    enforces both, and they are re-checked here).
 *
 * Before any of that, the raw header block must hold exactly one From with one
 * plain ASCII mailbox, no duplicated singleton field (RFC 5322 §3.6) and at
 * most {@link MAX_DKIM_SIGNATURES} signatures, counted over the raw bytes,
 * because a verifier signs the LAST instance of a field and a MIME parser
 * reads the FIRST.
 *
 * ## Addressed to the project
 *
 * A verified mail whose SIGNED To and Cc do not name this project's token is
 * `not_addressed_to_project`: a member's genuine mail to someone else, replayed
 * into the project by a recipient, or the member's own Bcc copy. The latter is
 * told apart by time: `member_verified` with a signed Date within
 * {@link BCC_WINDOW_MS} of receipt also gets `bcc_own`. The question is asked of
 * verified mail only; an unsigned To says whatever the sender typed, and
 * unverified mail is never pre-selected or followed anyway.
 *
 * Addresses are compared ASCII-lowercased and exact, so no Unicode case
 * folding (the Kelvin sign folds to `k`) makes two addresses equal.
 */

import { Resolver } from 'node:dns/promises'
import { authenticate, type AuthenticateResult, type DKIMResult, type DNSResolver } from 'mailauth'
import { addressParser } from 'postal-mime'
import { clampSentAt } from '@/lib/mail-thread/mail-threading'
import { asciiLower, parseInboundAddress } from './address'
import type { InboundSenderTrust, SenderFlag, SenderReason } from './contract'
import { headerValue, parseDateHeader, rawHeaderFields, type HeaderField } from './mime'

/** RFC 5322 §3.6: fields a message carries at most once. */
const SINGLETON_FIELDS = ['from', 'sender', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'reply-to', 'content-type', 'mime-version'] as const

/** What a verified signature must cover. */
const REQUIRED_SIGNED_FIELDS = ['from', 'subject', 'message-id', 'date'] as const

/**
 * More DKIM signatures than this are not verified at all. A real mail carries
 * one to three (the author's domain, an ESP, a list); each one is a DNS lookup,
 * so a thousand of them would be a thousand lookups on our time.
 */
export const MAX_DKIM_SIGNATURES = 8

/** RSA keys shorter than this do not verify (RFC 8301 §3.2). */
export const MIN_KEY_BITS = 1024

/** One DNS attempt waits this long, and is tried this often. */
const DNS_TIMEOUT_MS = 3_000
const DNS_TRIES = 2

/** The whole verification gives up, as `verifier_timeout`, after this. */
const VERIFY_DEADLINE_MS = 20_000

/** `signed_headers` holds at most this many field names. */
export const MAX_SIGNED_HEADERS = 64

/** The stored evidence line is at most this long. */
export const MAX_EVIDENCE_LENGTH = 4096

/** A member's own Bcc copy: its signed Date is at most this far from receipt. */
export const BCC_WINDOW_MS = 24 * 60 * 60 * 1000

/** A signed Date older than this before receipt is `stale_date`. */
export const STALE_DATE_MS = 7 * 24 * 60 * 60 * 1000

/** RFC 5321 dot-atom local part and an LDH domain, ASCII only. */
const ASCII_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/** What the bytes and DNS say. Input to {@link judgeSender}; nothing here is stored as is except as named. */
export interface SenderAuthentication {
  /** The single From address, ASCII-lowercased, or null when the From header does not name exactly one. */
  fromAddress: string | null
  /** Its domain, or null. */
  fromDomain: string | null
  /** Whether one aligned signature passed and met every hygiene rule. */
  verified: boolean
  /** Why (one code per mail; `dkim_pass` exactly when verified). */
  reason: SenderReason
  /** The `d=` of the admitting signature, or null. */
  signerDomain: string | null
  /** The field names the admitting signature covers (its `h=`), lowercased and distinct; empty when unverified. */
  signedHeaders: string[]
  /** Whether a To or Cc the admitting signature covers names the project's token. False when unverified. */
  signedRecipientNamesProject: boolean
  /** The RFC 8601 line we store: DKIM and DMARC only, never `spf=`. */
  authenticationResults: string
}

export interface AuthenticateSenderOptions {
  /** The token of the address the mail was delivered to. */
  projectToken: string
  /**
   * The deployment's inbound mail domain (`inboundMailDomain`). A signed
   * recipient names the project only in this domain, and it is the evidence
   * line's authserv-id and mailauth's `mta`.
   */
  inboundDomain: string
  /** The envelope sender, for mailauth's SPF context only (which is never read). */
  envelopeFrom?: string | null
  /** DNS TXT lookups; tests pass a fake. Defaults to `node:dns` with a timeout. */
  resolver?: DNSResolver
  /** How long the whole verification may take before it is `verifier_timeout`. */
  deadlineMs?: number
}

let defaultResolver: DNSResolver | null = null

/** TXT lookups (all DKIM and DMARC need) with a per-query timeout. */
function systemResolver(): DNSResolver {
  if (defaultResolver) return defaultResolver
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })
  defaultResolver = async (name: string, rrtype: string) => {
    if (rrtype !== 'TXT') throw Object.assign(new Error(`unsupported ${rrtype}`), { code: 'ENOTIMP' })
    return resolver.resolveTxt(name)
  }
  return defaultResolver
}

/** The mailboxes a header value names, groups flattened. */
function mailboxes(value: string): { name: string; address: string }[] {
  return addressParser(value, { flatten: true }).flatMap((entry) =>
    entry.address ? [{ name: entry.name, address: entry.address }] : []
  )
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1)
}

/** The first singleton field that occurs more than once, if any. */
function duplicatedSingleton(fields: readonly HeaderField[]): string | null {
  const counts = new Map<string, number>()
  for (const { name } of fields) counts.set(name, (counts.get(name) ?? 0) + 1)
  return SINGLETON_FIELDS.find((name) => (counts.get(name) ?? 0) > 1) ?? null
}

/** The field names a signature's `h=` lists, lowercased, distinct, in order. */
export function signedFieldNames(signature: DKIMResult): string[] {
  const keys = signature.signingHeaders?.keys ?? ''
  const names = keys
    .split(':')
    .map((name) => asciiLower(name.trim()))
    .filter(Boolean)
  return [...new Set(names)].slice(0, MAX_SIGNED_HEADERS)
}

/** Whether a To or Cc line the signature covers names the project's token. */
function signsProjectRecipient(signature: DKIMResult, projectToken: string, inboundDomain: string): boolean {
  for (const line of signature.signingHeaders?.headers ?? []) {
    const colon = line.indexOf(':')
    const name = asciiLower(line.slice(0, Math.max(0, colon)).trim())
    if (name !== 'to' && name !== 'cc') continue
    const value = line.slice(colon + 1).replace(/\r?\n/g, '')
    const named = mailboxes(value).some((mailbox) => {
      const parsed = parseInboundAddress(mailbox.address, inboundDomain)
      return parsed.kind === 'token' && parsed.token === projectToken
    })
    if (named) return true
  }
  return false
}

/** Relaxed alignment by label suffix, for naming why a NON-passing signature does not admit (mailauth decides a pass). */
function looselyAligned(signingDomain: string | undefined, fromDomain: string): boolean {
  const d = asciiLower(signingDomain ?? '')
  return d !== '' && (d === fromDomain || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`))
}

/**
 * What one signature says, as a {@link SenderReason}. `dkim_pass` admits.
 *
 * mailauth runs in its lenient default mode, which reports two failures as
 * `neutral` that this module names by what they are: a body hash that does not
 * match (the body was changed after signing: `dkim_fail`, as RFC 6376 §6.1.3
 * calls it) and an `x=` in the past (`dkim_expired`). Its `policy` result
 * says which rule refused the key in `policy.dkim-rules`.
 */
function judgeSignature(signature: DKIMResult, fromDomain: string): SenderReason {
  const result = signature.status.result
  const aligned = result === 'pass' ? Boolean(signature.status.aligned) : looselyAligned(signature.signingDomain, fromDomain)
  if (!aligned) return result === 'none' ? 'dkim_none' : 'dkim_unaligned'
  if (result === 'temperror' || result === 'temperr') return 'dkim_temperror'
  if (signature.signatureTimeValid === false) return 'dkim_expired'
  if (result === 'policy') return policyReason(signature)
  const bodyChanged = signature.bodyHash !== undefined && signature.bodyHashExpecting !== undefined && signature.bodyHash !== signature.bodyHashExpecting
  if (result === 'fail' || bodyChanged) return 'dkim_fail'
  if (result !== 'pass') return 'dkim_permerror'
  return hygieneOf(signature)
}

/** Which rule a `policy` result applied (mailauth's `policy.dkim-rules`). */
function policyReason(signature: DKIMResult): SenderReason {
  const rule = String(signature.status.policy?.['dkim-rules'] ?? '')
  if (rule === 'weak-algorithm' || asciiLower(signature.algo ?? '').endsWith('-sha1')) return 'dkim_weak_algorithm'
  if (rule === 'weak-key') return 'dkim_short_key'
  return 'dkim_policy'
}

/** The hygiene rules over a passing, aligned signature. */
function hygieneOf(signature: DKIMResult): SenderReason {
  if (signature.canonBodyLengthLimited || signature.status.underSized) return 'dkim_body_length'
  if (signature.status.testing) return 'dkim_testing'
  if (signature.signatureTimeValid === false) return 'dkim_expired'
  const signed = new Set(signedFieldNames(signature))
  if (REQUIRED_SIGNED_FIELDS.some((name) => !signed.has(name))) return 'dkim_unsigned_fields'
  if (asciiLower(signature.algo ?? '').endsWith('-sha1')) return 'dkim_weak_algorithm'
  if (signature.modulusLength !== undefined && signature.modulusLength < MIN_KEY_BITS) return 'dkim_short_key'
  return 'dkim_pass'
}

/**
 * The reasons ranked: when no signature admits, the mail reports the most
 * specific one any signature reached (`SENDER_REASONS` order). A mail with an
 * aligned signature that fails names that, however many unaligned ones pass.
 */
const SIGNATURE_RANK: readonly SenderReason[] = [
  'dkim_body_length',
  'dkim_testing',
  'dkim_expired',
  'dkim_unsigned_fields',
  'dkim_weak_algorithm',
  'dkim_short_key',
  'dkim_temperror',
  'dkim_fail',
  'dkim_policy',
  'dkim_permerror',
  'dkim_unaligned',
  'dkim_none',
]

function mostSpecific(reasons: readonly SenderReason[]): SenderReason {
  return SIGNATURE_RANK.find((reason) => reasons.includes(reason)) ?? 'dkim_none'
}

/** One line, bounded, of what a field from mailauth says. */
function cleanInfo(info: string): string {
  return info.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The RFC 8601 `Authentication-Results` line we store: the authserv-id, each
 * DKIM result and the DMARC result, as mailauth phrases them. Never SPF:
 * mailauth runs without the connecting IP here, and its `spf=temperror` would
 * assert a temporary failure that never happened (`sender-auth.spec.ts` and
 * the hostile corpus assert no stored line contains `spf=`).
 */
export function evidenceLine(authservId: string, result: Pick<AuthenticateResult, 'dkim' | 'dmarc'>): string {
  const parts = [
    ...result.dkim.results.map((signature) => cleanInfo(signature.info)),
    ...(result.dmarc ? [cleanInfo(result.dmarc.info)] : []),
  ].filter((part) => part !== '' && !/(^|\s)spf=/i.test(part))
  const line = [cleanInfo(authservId) || 'unknown', ...parts].join('; ')
  return line.length <= MAX_EVIDENCE_LENGTH ? line : line.slice(0, MAX_EVIDENCE_LENGTH)
}

function unverified(reason: SenderReason, from: { address: string | null; domain: string | null }, evidence: string): SenderAuthentication {
  return {
    fromAddress: from.address,
    fromDomain: from.domain,
    verified: false,
    reason,
    signerDomain: null,
    signedHeaders: [],
    signedRecipientNamesProject: false,
    authenticationResults: evidence,
  }
}

/** The single From mailbox of the raw header block, or why there is none. */
function singleFrom(fields: readonly HeaderField[]): { address: string; domain: string } | SenderReason {
  const fromFields = fields.filter((field) => field.name === 'from')
  if (fromFields.length !== 1) return 'from_count'
  const parsed = mailboxes(fromFields[0].value)
  if (parsed.length !== 1) return 'from_count'
  const address = asciiLower(parsed[0].address.trim())
  if (!ASCII_ADDRESS.test(address)) return 'from_not_ascii'
  return { address, domain: domainOf(address) }
}

async function evaluate(raw: Uint8Array, options: AuthenticateSenderOptions): Promise<SenderAuthentication> {
  const authservId = asciiLower(options.inboundDomain)
  const fields = rawHeaderFields(raw)
  const none = { address: null, domain: null }
  if (!fields) return unverified('header_malformed', none, authservId)
  const from = singleFrom(fields)
  if (typeof from === 'string') return unverified(from, none, authservId)
  if (duplicatedSingleton(fields)) return unverified('header_duplicate', from, authservId)
  if (fields.filter((field) => field.name === 'dkim-signature').length > MAX_DKIM_SIGNATURES) {
    return unverified('dkim_too_many', from, authservId)
  }

  const result = await authenticate(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
    resolver: options.resolver ?? systemResolver(),
    mta: authservId,
    sender: options.envelopeFrom || undefined,
    minBitLength: MIN_KEY_BITS,
    rejectRsaSha1: true,
    disableArc: true,
    disableBimi: true,
  })
  const evidence = evidenceLine(authservId, result)
  // Two parsers read the From line: mailauth's (alignment) and postal-mime's (ours). They must agree.
  if (result.dkim.headerFrom.length !== 1 || asciiLower(result.dkim.headerFrom[0]) !== from.address) {
    return unverified('from_count', from, evidence)
  }
  const judged = result.dkim.results.map((signature) => ({ signature, reason: judgeSignature(signature, from.domain) }))
  const admitting = judged.find((entry) => entry.reason === 'dkim_pass')?.signature
  if (!admitting) return unverified(mostSpecific(judged.map((entry) => entry.reason)), from, evidence)
  return {
    fromAddress: from.address,
    fromDomain: from.domain,
    verified: true,
    reason: 'dkim_pass',
    signerDomain: asciiLower(admitting.signingDomain ?? '') || null,
    signedHeaders: signedFieldNames(admitting),
    signedRecipientNamesProject: signsProjectRecipient(admitting, asciiLower(options.projectToken), authservId),
    authenticationResults: evidence,
  }
}

/**
 * Authenticate the sender of a raw message. Never throws: an exception is
 * `verifier_error` and a deadline `verifier_timeout`, both unverified, so a bug
 * or a slow DNS server labels a mail rather than losing it. The receive job
 * may retry a transient reason ({@link isTransientReason}) on an attempt that
 * is not its last.
 */
export async function authenticateSender(raw: Uint8Array, options: AuthenticateSenderOptions): Promise<SenderAuthentication> {
  const fields = rawHeaderFields(raw)
  const from = fields ? singleFrom(fields) : 'header_malformed'
  const fallback = typeof from === 'string' ? { address: null, domain: null } : from
  const authservId = asciiLower(options.inboundDomain)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SenderAuthentication>((resolve) => {
    timer = setTimeout(
      () => resolve(unverified('verifier_timeout', fallback, authservId)),
      options.deadlineMs ?? VERIFY_DEADLINE_MS
    )
  })
  try {
    return await Promise.race([evaluate(raw, options), deadline])
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown'
    console.warn(`[inbound-mail] sender authentication threw (${name}); labelling the mail unverified`)
    return unverified('verifier_error', fallback, authservId)
  } finally {
    clearTimeout(timer)
  }
}

/** Reasons a later attempt may answer differently. */
export function isTransientReason(reason: SenderReason): boolean {
  return reason === 'dkim_temperror' || reason === 'verifier_timeout' || reason === 'verifier_error'
}

/**
 * Reasons that say the From domain's own signature is broken or refused by
 * policy, rather than merely absent. Only these (and a look-alike domain) may
 * be shown as someone pretending to be a member; a plain unsigned mail never is.
 */
export function isRejectedSignature(reason: SenderReason): boolean {
  return reason === 'dkim_fail' || reason === 'dkim_policy' || reason === 'dkim_weak_algorithm' || reason === 'dkim_short_key'
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface JudgeSenderInput {
  /** The directory member whose address equals `authentication.fromAddress`, ASCII-lowercased and exact; null for none. */
  memberUserId: string | null
  /** When the webhook received the mail. */
  receivedAt: Date
  /** The Date header (`MailHeaders.sentAtHeader`); a verified mail's Date is signed. */
  sentAtHeader: Date | null
}

/** What the receive job stores about the sender. */
export interface SenderVerdict {
  trust: InboundSenderTrust
  /** Set only for `member_*`, as the database requires. */
  senderUserId: string | null
  flags: SenderFlag[]
  reason: SenderReason
  signerDomain: string | null
  signedHeaders: string[]
  authenticationResults: string
  /**
   * The Date header clamped by the thread core's `clampSentAt` (`[received − 30 days, received]`, else the receipt
   * time; up to 15 minutes fast is the receipt time without `date_out_of_range`).
   */
  sentAt: Date
  /** The Date header as sent, unclamped, or null. */
  sentAtHeader: Date | null
}

/** The trust label, the flags and the clamped send time. Pure. */
export function judgeSender(authentication: SenderAuthentication, input: JudgeSenderInput): SenderVerdict {
  const member = input.memberUserId !== null && authentication.fromAddress !== null
  const verified = authentication.verified
  const trust: InboundSenderTrust = member
    ? verified
      ? 'member_verified'
      : 'member_unverified'
    : verified
      ? 'external_verified'
      : 'external_unverified'
  const clamped = clampSentAt(input.sentAtHeader, input.receivedAt)
  const flags: SenderFlag[] = []
  const age = input.sentAtHeader ? input.receivedAt.getTime() - input.sentAtHeader.getTime() : null
  if (verified && !authentication.signedRecipientNamesProject) {
    flags.push('not_addressed_to_project')
    if (trust === 'member_verified' && age !== null && Math.abs(age) <= BCC_WINDOW_MS) flags.push('bcc_own')
  }
  if (verified && age !== null && age > STALE_DATE_MS) flags.push('stale_date')
  if (clamped.outOfRange) flags.push('date_out_of_range')
  return {
    trust,
    senderUserId: member ? input.memberUserId : null,
    flags,
    reason: authentication.reason,
    signerDomain: authentication.signerDomain,
    signedHeaders: authentication.signedHeaders,
    authenticationResults: authentication.authenticationResults,
    sentAt: clamped.sentAt,
    sentAtHeader: input.sentAtHeader,
  }
}

/**
 * Whether filing anything of this mail needs the person's explicit
 * acknowledgement of the sender (`acknowledgeSender`, ADR-0134 check C2): a
 * member's address without a verified domain, a signature the From domain's
 * own key refuses, a verified mail not addressed to the project (except the
 * member's own Bcc copy), or a stale signed Date. Never for a plain unsigned
 * mail from outside: that is the ordinary case, and an acknowledgement asked
 * for every time is one nobody reads.
 */
export function requiresSenderAcknowledgement(verdict: Pick<SenderVerdict, 'trust' | 'flags' | 'reason'>): boolean {
  if (verdict.trust === 'member_unverified') return true
  if (isRejectedSignature(verdict.reason)) return true
  if (verdict.flags.includes('not_addressed_to_project') && !verdict.flags.includes('bcc_own')) return true
  return verdict.flags.includes('stale_date')
}

/** The Date header of the raw block, for callers that have no `MailHeaders` (the unreadable path). */
export function dateHeaderOf(raw: Uint8Array): Date | null {
  const fields = rawHeaderFields(raw)
  return fields ? parseDateHeader(headerValue(fields, 'date')) : null
}
