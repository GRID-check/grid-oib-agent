/**
 * @vitest-environment node
 */
/**
 * Sender verification against REAL signatures: messages are DKIM-signed here
 * with a throwaway key, and `mailauth` verifies them against a fake DNS that
 * publishes the key and the DMARC record each case needs. Nothing is mocked
 * inside mailauth, so what passes here is what passes in production.
 */
import { generateKeyPairSync } from 'node:crypto'
import { dkimSign, type DNSResolver } from 'mailauth'
import { describe, expect, it } from 'vitest'
import { verifySender } from './sender-auth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const KEY_RECORD = `v=DKIM1; k=rsa; p=${PUBLIC_B64}`

function dnsError(code: string): Error {
  return Object.assign(new Error(`${code} (fake dns)`), { code })
}

/** TXT answers by name; anything else is NXDOMAIN, or a timeout for `failing`. */
function fakeDns(txt: Record<string, string>, failing = false): DNSResolver {
  return async (name: string, rrtype: string) => {
    if (failing) throw dnsError('ETIMEOUT')
    const value = rrtype === 'TXT' ? txt[name.toLowerCase()] : undefined
    if (value === undefined) throw dnsError('ENOTFOUND')
    return [[value]]
  }
}

function plainMessage(from: string): string {
  return [
    `From: ${from}`,
    'To: wohnbau.abcdefgh2345@piloti-post.at',
    'Subject: Pläne',
    'Date: Mon, 28 Sep 2026 10:15:00 +0200',
    'Message-ID: <m1@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hallo, anbei die Pläne.',
    '',
  ].join('\r\n')
}

async function signed(from: string, signingDomain: string): Promise<Uint8Array> {
  const message = plainMessage(from)
  // `signatureData`, not top-level keys: the signer ignores a top-level
  // `signingDomain` (the typings say otherwise) and returns no signature.
  const { signatures, errors } = await dkimSign(message, {
    signingDomain,
    selector: 'sel',
    privateKey: PRIVATE_PEM,
    signatureData: [{ signingDomain, selector: 'sel', privateKey: PRIVATE_PEM }],
  })
  expect(errors).toEqual([])
  expect(signatures).toContain(`d=${signingDomain}`)
  return new Uint8Array(Buffer.from(signatures + message))
}

describe('verifySender', () => {
  it('accepts an aligned DKIM signature with no DMARC record', async () => {
    const raw = await signed('Anna Muster <Anna@Buero-Muster.at>', 'buero-muster.at')
    const verdict = await verifySender(raw, {
      resolver: fakeDns({ 'sel._domainkey.buero-muster.at': KEY_RECORD }),
    })
    expect(verdict).toEqual({ verified: true, fromAddress: 'anna@buero-muster.at', via: 'aligned-dkim' })
  })

  it('accepts relaxed alignment: a subdomain signs for the organizational domain', async () => {
    const raw = await signed('anna@buero-muster.at', 'mail.buero-muster.at')
    const verdict = await verifySender(raw, {
      resolver: fakeDns({
        'sel._domainkey.mail.buero-muster.at': KEY_RECORD,
        '_dmarc.buero-muster.at': 'v=DMARC1; p=none',
      }),
    })
    expect(verdict).toMatchObject({ verified: true, via: 'aligned-dkim' })
  })

  it('refuses an unaligned signature (M365 onmicrosoft.com) when DMARC does not enforce', async () => {
    const raw = await signed('anna@buero-muster.at', 'buero-muster.onmicrosoft.com')
    const key = { 'sel._domainkey.buero-muster.onmicrosoft.com': KEY_RECORD }

    const withoutDmarc = await verifySender(raw, { resolver: fakeDns(key) })
    expect(withoutDmarc).toEqual({ verified: false, reason: 'dkim-unaligned' })

    const monitoringOnly = await verifySender(raw, {
      resolver: fakeDns({ ...key, '_dmarc.buero-muster.at': 'v=DMARC1; p=none' }),
    })
    expect(monitoringOnly).toEqual({ verified: false, reason: 'dkim-unaligned' })
  })

  it('accepts an unaligned signature when the From domain enforces DMARC', async () => {
    const raw = await signed('anna@buero-muster.at', 'buero-muster.onmicrosoft.com')
    for (const policy of ['reject', 'quarantine']) {
      const verdict = await verifySender(raw, {
        resolver: fakeDns({
          'sel._domainkey.buero-muster.onmicrosoft.com': KEY_RECORD,
          '_dmarc.buero-muster.at': `v=DMARC1; p=${policy}`,
        }),
      })
      expect(verdict, policy).toMatchObject({ verified: true, via: 'enforcing-dmarc' })
    }
  })

  it('accepts an unsigned message from an enforcing domain (Cloudflare checked SPF upstream)', async () => {
    const raw = new Uint8Array(Buffer.from(plainMessage('anna@buero-muster.at')))
    const verdict = await verifySender(raw, {
      resolver: fakeDns({ '_dmarc.buero-muster.at': 'v=DMARC1; p=reject' }),
    })
    expect(verdict).toMatchObject({ verified: true, via: 'enforcing-dmarc' })
  })

  it('does not count a testing record (t=y) as enforcing', async () => {
    const raw = new Uint8Array(Buffer.from(plainMessage('anna@buero-muster.at')))
    const verdict = await verifySender(raw, {
      resolver: fakeDns({ '_dmarc.buero-muster.at': 'v=DMARC1; p=quarantine; t=y' }),
    })
    expect(verdict.verified).toBe(false)
  })

  it('refuses an unsigned message from a domain without DMARC', async () => {
    const raw = new Uint8Array(Buffer.from(plainMessage('anna@buero-muster.at')))
    expect(await verifySender(raw, { resolver: fakeDns({}) })).toEqual({
      verified: false,
      reason: 'no-dkim-pass',
    })
  })

  it('refuses a signature whose key does not verify (a forged From)', async () => {
    const raw = await signed('anna@buero-muster.at', 'buero-muster.at')
    const { publicKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const wrongKey = `v=DKIM1; k=rsa; p=${otherKey.export({ type: 'spki', format: 'der' }).toString('base64')}`
    const verdict = await verifySender(raw, {
      resolver: fakeDns({ 'sel._domainkey.buero-muster.at': wrongKey }),
    })
    expect(verdict.verified).toBe(false)
  })

  it('refuses when DNS fails, even for a message that would otherwise pass', async () => {
    const raw = await signed('anna@buero-muster.at', 'buero-muster.at')
    const verdict = await verifySender(raw, { resolver: fakeDns({}, true) })
    expect(verdict.verified).toBe(false)
  })

  it('refuses a message with two From addresses', async () => {
    const raw = new Uint8Array(
      Buffer.from(plainMessage('anna@buero-muster.at, mallory@evil.test'))
    )
    const verdict = await verifySender(raw, {
      resolver: fakeDns({ '_dmarc.buero-muster.at': 'v=DMARC1; p=reject' }),
    })
    expect(verdict).toEqual({ verified: false, reason: 'from-header' })
  })

  it('refuses garbage without throwing', async () => {
    const verdict = await verifySender(new Uint8Array(Buffer.from('not a message at all')), {
      resolver: fakeDns({}),
    })
    expect(verdict.verified).toBe(false)
  })

  it('refuses, rather than throws, when the resolver itself blows up', async () => {
    const raw = await signed('anna@buero-muster.at', 'buero-muster.at')
    const verdict = await verifySender(raw, {
      resolver: () => {
        throw new TypeError('resolver bug')
      },
    })
    expect(verdict.verified).toBe(false)
  })
})
