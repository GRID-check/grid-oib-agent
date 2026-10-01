/**
 * Is the From header telling the truth, and was the mail meant for this
 * project? (ADR-0075)
 *
 * Cloudflare Email Routing does not hand its SPF, DKIM or DMARC verdicts to the
 * Worker (cloudflare/workerd#6740), and the Worker does not see the connecting
 * IP, so nothing upstream can be relied on. The BFF decides from the raw bytes
 * and DNS, and a mail is authentic ONLY when one DKIM signature on it:
 *
 *   1. verifies (`mailauth` does the cryptography);
 *   2. is aligned with the single From domain (relaxed: the same
 *      organizational domain, by the Public Suffix List);
 *   3. covers the whole body: no `l=` tag, which would let anyone append a
 *      part below the signed bytes;
 *   4. signs `from`, `subject`, and `to` or `cc`;
 *   5. signs a To or Cc header that names THIS project's address. A genuine
 *      signed mail the member sent to somebody else cannot be replayed into a
 *      project, and neither can a Bcc: a Bcc to the project address is
 *      refused, because no signed header says the member meant the project;
 *   6. uses a key that is not in testing mode (`t=y`, RFC 6376 §3.6.1) and is
 *      not rsa-sha1 (RFC 8301).
 *
 * There is no DMARC-policy rule. "The domain publishes p=reject, so what
 * arrived must have passed upstream" admitted unsigned spoofs whenever the
 * policy was not enforced (`pct`, `t=y`, quarantine), and whenever the sender
 * held the token and bypassed Cloudflare.
 *
 * Before any of that, the raw header block is checked: exactly one From, and
 * at most one of each field RFC 5322 §3.6 allows once. Counted over the raw
 * bytes, because a DKIM verifier signs the LAST instance of a field and a MIME
 * parser reads the FIRST, and an unsigned duplicate above the signature is how
 * a signed mail gets a new Subject, recipient or MIME boundary.
 *
 * The verdict is three-valued. `temperror` means DNS or the verifier could not
 * decide (a SERVFAIL, a timeout, an exception): the webhook answers 503 and the
 * sending server retries. Only `fail` refuses the mail.
 *
 * Addresses are ASCII: a From whose address is not plain ASCII is refused, and
 * addresses are lowercased ASCII-only, so no Unicode case folding (the Kelvin
 * sign folds to `k`) can make two addresses compare equal.
 */

import { Resolver } from 'node:dns/promises'
import { dkimVerify, type DKIMResult, type DNSResolver } from 'mailauth'
import { addressParser } from 'postal-mime'
import { asciiLower, parseInboundAddress } from './address'
import type { SenderVerdict } from './types'

/** RFC 5322 §3.6: fields a message carries at most once. */
const SINGLETON_FIELDS = [
  'from',
  'sender',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'content-type',
  'mime-version',
] as const

/** One DNS attempt waits this long, and is tried this often. */
const DNS_TIMEOUT_MS = 3_000
const DNS_TRIES = 2

/** The whole verification gives up (as `temperror`) after this. */
const VERIFY_DEADLINE_MS = 20_000

/**
 * The reasons a signature does not admit the mail, in the order they are
 * checked. When no signature admits it, the reason of the signature that got
 * furthest is reported.
 */
const SIGNATURE_REASONS = [
  'dkim-unaligned',
  'dkim-body-length',
  'dkim-headers',
  'dkim-recipient',
  'dkim-weak-algorithm',
  'dkim-invalid',
  'dkim-testing',
] as const
type SignatureReason = (typeof SIGNATURE_REASONS)[number]

type SignatureOutcome = 'pass' | 'temperror' | SignatureReason

/**
 * Fields `dkimVerify` sets on every result (mailauth 5.0.3,
 * `lib/dkim/dkim-verifier.js`) that its typings leave out. Later mailauth
 * versions type them; the names are the same.
 */
interface VerifiedSignature extends DKIMResult {
  /** The `a=` tag, e.g. `rsa-sha256`. */
  algo?: string
  /** The key record as found in DNS. */
  rr?: string
  /** True when the signature has an `l=` tag. */
  canonBodyLengthLimited?: boolean
  /** The header lines the signature covers, as they appear in the message. */
  signingHeaders?: { keys: string; headers: string[] }
}

export interface VerifySenderOptions {
  /** The token of the address the mail was delivered to. */
  projectToken: string
  /** DNS lookups, for tests. Defaults to `node:dns` with a timeout. */
  resolver?: DNSResolver
  /** How long the whole verification may take before it is a `temperror`. */
  deadlineMs?: number
}

let defaultResolver: DNSResolver | null = null

/** TXT lookups (all DKIM needs) with a per-query timeout. */
function systemResolver(): DNSResolver {
  if (defaultResolver) return defaultResolver
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })
  defaultResolver = async (name: string, rrtype: string) => {
    if (rrtype !== 'TXT')
      throw Object.assign(new Error(`unsupported ${rrtype}`), { code: 'ENOTIMP' })
    return resolver.resolveTxt(name)
  }
  return defaultResolver
}

/**
 * The header fields of the raw message, unfolded, in order, duplicates kept.
 * The block ends at the first empty line, as it does for mailauth's parser.
 * `null` when a line in it is neither a field nor a continuation.
 */
export function rawHeaderFields(raw: Uint8Array): { name: string; value: string }[] | null {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const ends = [bytes.indexOf('\n\n'), bytes.indexOf('\n\r\n')].filter((index) => index !== -1)
  // Only the header block is decoded, never a 26 MiB body.
  const text = bytes.toString('utf8', 0, ends.length > 0 ? Math.min(...ends) + 1 : bytes.length)
  const fields: { name: string; value: string }[] = []
  let start = 0
  if (text.startsWith('\n') || text.startsWith('\r\n')) return null
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end).replace(/\r$/, '')
    start = end + 1
    if (line === '') break
    if (line[0] === ' ' || line[0] === '\t') {
      const last = fields[fields.length - 1]
      if (!last) return null
      last.value += line
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    fields.push({ name: asciiLower(line.slice(0, colon).trim()), value: line.slice(colon + 1) })
  }
  return fields
}

/** The first singleton field that occurs more than once, if any. */
function duplicatedSingleton(fields: readonly { name: string }[]): string | null {
  const counts = new Map<string, number>()
  for (const { name } of fields) counts.set(name, (counts.get(name) ?? 0) + 1)
  return SINGLETON_FIELDS.find((name) => (counts.get(name) ?? 0) > 1) ?? null
}

/** RFC 5321 dot-atom local part and an LDH domain, ASCII only. */
const ASCII_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/** The mailboxes a header value names, groups flattened. */
function mailboxes(value: string): { name: string; address: string }[] {
  return addressParser(value, { flatten: true }).flatMap((entry) => (entry.address ? [entry] : []))
}

/**
 * The project token an address carries, by the same parser the envelope
 * recipient goes through (`+detail` and quotes stripped, last-dot split). The
 * domain is not ours to check here: only the member's own signer could have
 * put a sixty-bit token into a signed header.
 */
function addressToken(address: string): string | null {
  const parsed = parseInboundAddress(address, address.slice(address.lastIndexOf('@') + 1))
  return parsed.kind === 'token' ? parsed.token : null
}

/** The field names a signature covers, lowercased. */
function signedFieldNames(signature: VerifiedSignature): Set<string> {
  const lines = signature.signingHeaders?.headers ?? []
  return new Set(
    lines.map((line) => asciiLower(line.slice(0, Math.max(0, line.indexOf(':'))).trim()))
  )
}

/** Whether a To or Cc line the signature covers names the project address. */
function signsProjectRecipient(signature: VerifiedSignature, projectToken: string): boolean {
  for (const line of signature.signingHeaders?.headers ?? []) {
    const colon = line.indexOf(':')
    const name = asciiLower(line.slice(0, Math.max(0, colon)).trim())
    if (name !== 'to' && name !== 'cc') continue
    const value = line.slice(colon + 1).replace(/\r?\n/g, '')
    if (mailboxes(value).some((mailbox) => addressToken(mailbox.address) === projectToken))
      return true
  }
  return false
}

/** Key record flag `t=y`: the domain is testing DKIM (RFC 6376 §3.6.1). */
function keyIsTesting(record: string | undefined): boolean {
  const flags = /(?:^|;)\s*t\s*=\s*([^;]*)/i.exec(record ?? '')?.[1] ?? ''
  return flags.split(':').some((flag) => flag.trim().toLowerCase() === 'y')
}

/** What one signature says about the mail. Pure. */
function judgeSignature(signature: VerifiedSignature, projectToken: string): SignatureOutcome {
  if (!signature.status.aligned) return 'dkim-unaligned'
  if (signature.canonBodyLengthLimited || signature.status.underSized) return 'dkim-body-length'
  const signed = signedFieldNames(signature)
  if (!signed.has('from') || !signed.has('subject') || !(signed.has('to') || signed.has('cc'))) {
    return 'dkim-headers'
  }
  if (!signsProjectRecipient(signature, projectToken)) return 'dkim-recipient'
  if (asciiLower(signature.algo ?? '').endsWith('-sha1')) return 'dkim-weak-algorithm'
  const result = signature.status.result
  if (result === 'temperror' || result === 'temperr') return 'temperror'
  if (result !== 'pass') return 'dkim-invalid'
  if (keyIsTesting(signature.rr)) return 'dkim-testing'
  return 'pass'
}

/** The verdict over all signatures: any pass admits, any doubt retries. */
function combine(outcomes: readonly SignatureOutcome[]): SenderVerdict | null {
  if (outcomes.length === 0) return { verdict: 'fail', reason: 'no-dkim-signature' }
  if (outcomes.includes('pass')) return null
  if (outcomes.includes('temperror')) return { verdict: 'temperror', reason: 'dkim-temperror' }
  const furthest = Math.max(
    ...outcomes.map((outcome) => SIGNATURE_REASONS.indexOf(outcome as SignatureReason))
  )
  return { verdict: 'fail', reason: SIGNATURE_REASONS[furthest] }
}

function fail(reason: string): SenderVerdict {
  return { verdict: 'fail', reason }
}

/**
 * Decide whether the message's From header may be believed and whether the
 * signer addressed it to the project. Never throws: an exception is a
 * `temperror`, so a bug here delays mail instead of bouncing it.
 */
export async function verifySender(
  raw: Uint8Array,
  options: VerifySenderOptions
): Promise<SenderVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SenderVerdict>((resolve) => {
    timer = setTimeout(
      () => resolve({ verdict: 'temperror', reason: 'timeout' }),
      options.deadlineMs ?? VERIFY_DEADLINE_MS
    )
  })
  try {
    return await Promise.race([evaluate(raw, options), deadline])
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown'
    console.warn(`[inbound-mail] sender verification threw (${name}); answering temperror`)
    return { verdict: 'temperror', reason: 'exception' }
  } finally {
    clearTimeout(timer)
  }
}

async function evaluate(raw: Uint8Array, options: VerifySenderOptions): Promise<SenderVerdict> {
  const fields = rawHeaderFields(raw)
  if (!fields) return fail('header-malformed')
  const duplicate = duplicatedSingleton(fields)
  if (duplicate) return fail(`header-duplicate:${duplicate}`)
  const fromField = fields.find((field) => field.name === 'from')
  if (!fromField) return fail('from-header')

  // Two parsers read the From line: mailauth's (alignment) and postal-mime's
  // (the display name, and the rest of the pipeline). They must agree on one
  // plain ASCII mailbox, or a parser differential decides who the sender is.
  const parsedFrom = mailboxes(fromField.value)
  if (parsedFrom.length !== 1) return fail('from-header')
  const fromAddress = asciiLower(parsedFrom[0].address)
  if (!ASCII_ADDRESS.test(fromAddress)) return fail('from-address')

  const dkim = await dkimVerify(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
    resolver: options.resolver ?? systemResolver(),
  })
  if (dkim.headerFrom.length !== 1 || asciiLower(dkim.headerFrom[0]) !== fromAddress)
    return fail('from-header')

  // An unsigned message comes back as one pseudo-result with status `none`.
  const signatures: VerifiedSignature[] = dkim.results.filter(
    (result) => result.status.result !== 'none'
  )
  const projectToken = asciiLower(options.projectToken)
  const refusal = combine(signatures.map((signature) => judgeSignature(signature, projectToken)))
  if (refusal) return refusal
  return { verdict: 'pass', fromAddress, fromName: parsedFrom[0].name.trim() || null }
}
