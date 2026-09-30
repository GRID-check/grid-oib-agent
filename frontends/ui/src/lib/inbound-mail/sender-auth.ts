/**
 * Is the From header telling the truth? (ADR-0074)
 *
 * Cloudflare Email Routing rejects mail that fails SPF and DKIM, or an
 * enforcing DMARC policy, before it reaches the Worker — but it does not hand
 * its verdicts to the Worker (cloudflare/workerd#6740), and the Worker does not
 * see the connecting IP either. So the BFF decides for itself, from the raw
 * bytes and DNS, and ACCEPTS only when one of two things holds:
 *
 *   (a) the message carries a DKIM signature that verifies AND whose `d=` is
 *       aligned with the From domain (relaxed: the same organizational domain);
 *   (b) the From domain publishes an enforcing DMARC policy (`p=reject` or
 *       `p=quarantine`). Cloudflare enforced it upstream, so arrival means the
 *       message passed — typically on SPF, which only Cloudflare could check.
 *
 * Everything else is refused, and so is every doubt: a DNS failure, a message
 * with two From addresses, an exception anywhere in here. The known cost: a
 * Microsoft 365 tenant without custom DKIM signs as `*.onmicrosoft.com`, which
 * does not align, and without an enforcing DMARC record its mail is refused.
 * The user guide says so.
 *
 * `mailauth` (postalsys) does the DKIM verification, the DMARC record discovery
 * (RFC 9989 tree walk) and the alignment. Nothing here re-implements any of it.
 */

import { dkimVerify, dmarc, type DNSResolver } from 'mailauth'

/** Policies that make Cloudflare reject or junk a failing message upstream. */
const ENFORCING_POLICIES = new Set(['reject', 'quarantine'])

export type SenderVerdict =
  | {
      verified: true
      /** The From address, as an addr-spec, lowercased. */
      fromAddress: string
      /** Which rule admitted it — for the log line, never for the sender. */
      via: 'aligned-dkim' | 'enforcing-dmarc'
    }
  | { verified: false; reason: string }

export interface VerifySenderOptions {
  /** DNS lookups, for tests. Defaults to `node:dns`. */
  resolver?: DNSResolver
}

function refuse(reason: string): SenderVerdict {
  return { verified: false, reason }
}

/**
 * Decide whether the message's From header may be believed. Never throws:
 * anything that goes wrong is a refusal.
 */
export async function verifySender(
  raw: Uint8Array,
  options: VerifySenderOptions = {}
): Promise<SenderVerdict> {
  try {
    return await evaluate(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), options.resolver)
  } catch (error) {
    console.warn('[inbound-mail] sender verification threw, refusing:', error)
    return refuse('exception')
  }
}

async function evaluate(raw: Buffer, resolver: DNSResolver | undefined): Promise<SenderVerdict> {
  const dkim = await dkimVerify(raw, resolver ? { resolver } : {})
  if (dkim.fromFields !== 1 || dkim.headerFrom.length !== 1) return refuse('from-header')
  const fromAddress = dkim.headerFrom[0].toLowerCase()
  if (!fromAddress.includes('@')) return refuse('from-header')

  const passing = dkim.results.filter((result) => result.status.result === 'pass' && result.signingDomain)
  const verdict = await dmarc({
    headerFrom: dkim.headerFrom,
    fromFields: dkim.fromFields,
    dkimDomains: passing.map((result) => ({
      id: result.id,
      domain: result.signingDomain as string,
      aligned: result.status.aligned,
      underSized: result.status.underSized,
    })),
    ...(resolver ? { resolver } : {}),
  })
  if (!verdict) return refuse('dmarc-unevaluable')

  const status = verdict.status.result
  // A failed lookup decides nothing either way: the record might say reject,
  // and alignment might have gone the other way. Fail closed.
  if (status === 'temperror' || status === 'temperr' || status === 'permerror') {
    return refuse(`dmarc-${status}`)
  }

  // (a) with a DMARC record: DMARC's own alignment verdict, which honours the
  // domain's `adkim`. No SPF domains were offered, so a pass is a DKIM pass.
  if (status === 'pass' && verdict.alignment.dkim.result) {
    return { verified: true, fromAddress, via: 'aligned-dkim' }
  }

  // (b) an enforcing policy: Cloudflare already refused what failed it.
  if (verdict.rr && ENFORCING_POLICIES.has(verdict.policy)) {
    return { verified: true, fromAddress, via: 'enforcing-dmarc' }
  }

  // (a) without a DMARC record: relaxed alignment by organizational domain,
  // as `dkimVerify` judged it for each passing signature.
  if (status === 'none' && passing.some((result) => Boolean(result.status.aligned))) {
    return { verified: true, fromAddress, via: 'aligned-dkim' }
  }

  return refuse(passing.length > 0 ? 'dkim-unaligned' : 'no-dkim-pass')
}
