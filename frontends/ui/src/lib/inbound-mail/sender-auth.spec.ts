/**
 * @vitest-environment node
 */
/**
 * Sender verification against REAL signatures: messages are DKIM-signed here
 * with a throwaway key, and `mailauth` verifies them against a fake DNS that
 * publishes the key each case needs. Nothing inside mailauth is mocked, so what
 * passes here is what passes in production.
 *
 * The refusals are the attacks reviewers A and B demonstrated against the
 * first version (probe ids in the test names).
 */
import { generateKeyPairSync } from 'node:crypto'
import { dkimSign, type DKIMSignOptions, type DNSResolver } from 'mailauth'
import { describe, expect, it } from 'vitest'
import { rawHeaderFields, verifySender } from './sender-auth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const KEY_RECORD = `v=DKIM1; k=rsa; p=${PUBLIC_B64}`

const TOKEN = 'abcdefgh2345'
const PROJECT_ADDRESS = `wohnbau.${TOKEN}@piloti-post.at`
const ANNA = 'Anna Muster <anna@buero-muster.at>'

function dnsError(code: string): Error {
  return Object.assign(new Error(`${code} (fake dns)`), { code })
}

/** TXT answers by name; `failing` names time out; anything else is NXDOMAIN. */
function fakeDns(txt: Record<string, string>, failing: string[] = []): DNSResolver {
  return async (name: string, rrtype: string) => {
    const lower = name.toLowerCase()
    if (failing.includes(lower)) throw dnsError('ETIMEOUT')
    const value = rrtype === 'TXT' ? txt[lower] : undefined
    if (value === undefined) throw dnsError('ENOTFOUND')
    return [[value]]
  }
}

const keyFor = (domain: string, record = KEY_RECORD) => ({ [`sel._domainkey.${domain}`]: record })

interface MessageSpec {
  from?: string
  to?: string
  cc?: string
  body?: string
}

function message({
  from = ANNA,
  to = PROJECT_ADDRESS,
  cc,
  body = 'Hallo, anbei die Pläne.',
}: MessageSpec = {}): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    'Subject: Pläne',
    'Date: Mon, 28 Sep 2026 10:15:00 +0200',
    'Message-ID: <m1@buero-muster.at>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n')
}

interface SignSpec {
  /** Colon-separated `h=` list (mailauth reads only a string here). */
  headerList?: string
  maxBodyLength?: number
  algorithm?: string
}

/** The message with a DKIM-Signature for `domain` prepended. */
async function sign(raw: string, domain: string, spec: SignSpec = {}): Promise<string> {
  const entry: DKIMSignOptions = {
    signingDomain: domain,
    selector: 'sel',
    privateKey: PRIVATE_PEM,
    ...(spec.maxBodyLength !== undefined ? { maxBodyLength: spec.maxBodyLength } : {}),
    ...(spec.algorithm ? { algorithm: spec.algorithm } : {}),
  }
  const options: DKIMSignOptions = { ...entry, signatureData: [entry] }
  if (spec.headerList) Object.assign(options, { headerList: spec.headerList })
  const { signatures, errors } = await dkimSign(raw, options)
  expect(errors).toEqual([])
  expect(signatures).toContain(`d=${domain}`)
  return signatures + raw
}

const bytes = (raw: string) => new Uint8Array(Buffer.from(raw))

async function verdictOf(raw: string, txt: Record<string, string>, failing: string[] = []) {
  return verifySender(bytes(raw), { projectToken: TOKEN, resolver: fakeDns(txt, failing) })
}

describe('verifySender: what it admits', () => {
  it('admits an aligned signature over From, Subject and the To naming the project', async () => {
    const raw = await sign(
      message({ from: 'Anna Muster <Anna@Buero-Muster.at>' }),
      'buero-muster.at'
    )
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'pass',
      fromAddress: 'anna@buero-muster.at',
      fromName: 'Anna Muster',
    })
  })

  it('admits relaxed alignment: a subdomain signs for the organizational domain', async () => {
    const raw = await sign(message(), 'mail.buero-muster.at')
    expect(await verdictOf(raw, keyFor('mail.buero-muster.at'))).toMatchObject({ verdict: 'pass' })
  })

  it('admits the project address in a signed Cc, and with +detail', async () => {
    const cc = await sign(
      message({ to: 'lieferant@extern.at', cc: PROJECT_ADDRESS }),
      'buero-muster.at'
    )
    expect(await verdictOf(cc, keyFor('buero-muster.at'))).toMatchObject({ verdict: 'pass' })
    const plus = await sign(
      message({ to: `"Projekt" <wohnbau.${TOKEN}+plaene@piloti-post.at>` }),
      'buero-muster.at'
    )
    expect(await verdictOf(plus, keyFor('buero-muster.at'))).toMatchObject({ verdict: 'pass' })
  })

  it('does not look up DMARC at all: a failing _dmarc lookup changes nothing (S8a, D)', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const verdict = await verdictOf(raw, keyFor('buero-muster.at'), ['_dmarc.buero-muster.at'])
    expect(verdict).toMatchObject({ verdict: 'pass' })
  })

  it('reports the display-name trick as the attacker it is (S6, S11)', async () => {
    for (const from of [
      '"maria@firma.at" <att@evil.at>',
      '=?utf-8?q?maria=40firma=2Eat?= <att@evil.at>',
    ]) {
      const raw = await sign(message({ from }), 'evil.at')
      expect(await verdictOf(raw, keyFor('evil.at')), from).toMatchObject({
        verdict: 'pass',
        fromAddress: 'att@evil.at',
      })
    }
  })
})

describe('verifySender: no DMARC rule (A1, B1)', () => {
  it.each([
    ['p=reject', 'v=DMARC1; p=reject'],
    ['p=quarantine', 'v=DMARC1; p=quarantine'],
    ['p=quarantine; pct=0', 'v=DMARC1; p=quarantine; pct=0'],
    ['p=reject; t=y', 'v=DMARC1; p=reject; t=y'],
  ])('refuses an unsigned spoof whatever the policy says (%s)', async (_label, record) => {
    const verdict = await verdictOf(message(), { '_dmarc.buero-muster.at': record })
    expect(verdict).toEqual({ verdict: 'fail', reason: 'no-dkim-signature' })
  })

  it('refuses an unaligned signature from an enforcing domain (M365 onmicrosoft, F)', async () => {
    const raw = await sign(message(), 'buero-muster.onmicrosoft.com')
    const verdict = await verdictOf(raw, {
      ...keyFor('buero-muster.onmicrosoft.com'),
      '_dmarc.buero-muster.at': 'v=DMARC1; p=reject',
    })
    expect(verdict).toEqual({ verdict: 'fail', reason: 'dkim-unaligned' })
  })

  it.each(['buero-muster-at.20230601.gappssmtp.com', 'sendgrid.net'])(
    'refuses a third-party signer that does not align (%s, G, H)',
    async (domain) => {
      const raw = await sign(message(), domain)
      expect(await verdictOf(raw, keyFor(domain))).toEqual({
        verdict: 'fail',
        reason: 'dkim-unaligned',
      })
    }
  )
})

describe('verifySender: replay (A2, S2, L)', () => {
  it('refuses a genuine signed mail the member sent to somebody else', async () => {
    const raw = await sign(message({ to: 'engineer@extern.at' }), 'buero-muster.at')
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-recipient',
    })
  })

  it('refuses a mail addressed to another project (a different token)', async () => {
    const raw = await sign(message({ to: 'andere.zzzzzzzz2345@piloti-post.at' }), 'buero-muster.at')
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-recipient',
    })
  })

  it('refuses a Bcc to the project: no signed header names it', async () => {
    const raw = await sign(message({ to: 'kollege@buero-muster.at' }), 'buero-muster.at')
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-recipient',
    })
  })

  it('refuses a signature whose h= leaves To and Cc out, so the recipient is not signed', async () => {
    const raw = await sign(message(), 'buero-muster.at', {
      headerList: 'from:subject:date:message-id',
    })
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-headers',
    })
  })

  it('refuses a signature whose h= leaves Subject out', async () => {
    const raw = await sign(message(), 'buero-muster.at', { headerList: 'from:to:date:message-id' })
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-headers',
    })
  })
})

describe('verifySender: l= and unsigned duplicates (A3, B2)', () => {
  it('refuses an l= signature, with or without appended content (S3a, J, K)', async () => {
    const body = 'Hallo'
    const raw = await sign(message({ body }), 'buero-muster.at', { maxBodyLength: body.length + 2 })
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-body-length',
    })
    const tampered = `${raw}--- appended by the attacker ---\r\n`
    expect(await verdictOf(tampered, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-body-length',
    })
  })

  it.each([
    ['subject', 'Subject: Einreichplan FINAL'],
    ['from', 'From: att@evil.at'],
    ['to', `To: ${PROJECT_ADDRESS}`],
    ['content-type', 'Content-Type: multipart/mixed; boundary="EVIL"'],
    ['message-id', 'Message-ID: <replay-1@x>'],
    ['date', 'Date: Tue, 29 Sep 2026 10:00:00 +0200'],
    ['mime-version', 'MIME-Version: 1.0'],
  ])(
    'refuses a second %s prepended above the signature (S4, S9b, auth2, auth3)',
    async (name, line) => {
      const raw = await sign(message(), 'buero-muster.at')
      expect(await verdictOf(`${line}\r\n${raw}`, keyFor('buero-muster.at'))).toEqual({
        verdict: 'fail',
        reason: `header-duplicate:${name}`,
      })
    }
  )

  it('counts over the raw block, folded lines and odd case included', () => {
    const fields = rawHeaderFields(
      bytes('SUBJECT: a\r\n\tfolded\r\nsubject : b\r\n\r\nSubject: in the body\r\n')
    )
    expect(fields).toEqual([
      { name: 'subject', value: ' a\tfolded' },
      { name: 'subject', value: ' b' },
    ])
  })

  it('refuses a header block with a line that is neither a field nor a continuation', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const broken = raw.replace('MIME-Version: 1.0', 'MIME-Version: 1.0\r\nnot a header line')
    expect(await verdictOf(broken, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'header-malformed',
    })
  })
})

describe('verifySender: the From address (A7, S7, S9a, S12)', () => {
  it('refuses two addresses in one From', async () => {
    const raw = await sign(message({ from: 'anna@buero-muster.at, att@evil.at' }), 'evil.at')
    expect(await verdictOf(raw, keyFor('evil.at'))).toEqual({
      verdict: 'fail',
      reason: 'from-header',
    })
  })

  it('refuses a non-ASCII local part (the Kelvin sign folds to k)', async () => {
    const raw = await sign(message({ from: 'Kurt <Kurt@buero-muster.at>' }), 'buero-muster.at')
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'from-address',
    })
  })

  it('refuses a quoted local part that holds an address', async () => {
    const raw = await sign(message({ from: '<"maria@firma.at"@evil.at>' }), 'evil.at')
    expect(await verdictOf(raw, keyFor('evil.at'))).toMatchObject({ verdict: 'fail' })
  })

  it('refuses a message without From', async () => {
    const verdict = await verdictOf(message().replace(/^From: .*\r\n/, ''), {})
    expect(verdict).toEqual({ verdict: 'fail', reason: 'from-header' })
  })
})

describe('verifySender: the signature itself', () => {
  it('refuses a signature that does not verify (a forged From)', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const { publicKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const wrongKey = `v=DKIM1; k=rsa; p=${other.export({ type: 'spki', format: 'der' }).toString('base64')}`
    expect(await verdictOf(raw, keyFor('buero-muster.at', wrongKey))).toEqual({
      verdict: 'fail',
      reason: 'dkim-invalid',
    })
  })

  it('refuses a body changed after signing', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const changed = raw.replace('Hallo, anbei die Pläne.', 'Hallo, anbei die Rechnung.')
    expect(await verdictOf(changed, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-invalid',
    })
  })

  it('refuses a key in testing mode (t=y)', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const testing = keyFor('buero-muster.at', `v=DKIM1; k=rsa; t=y; p=${PUBLIC_B64}`)
    expect(await verdictOf(raw, testing)).toEqual({ verdict: 'fail', reason: 'dkim-testing' })
  })

  it('refuses rsa-sha1', async () => {
    const raw = await sign(message(), 'buero-muster.at', { algorithm: 'rsa-sha1' })
    expect(await verdictOf(raw, keyFor('buero-muster.at'))).toEqual({
      verdict: 'fail',
      reason: 'dkim-weak-algorithm',
    })
  })

  it('reports the signature that got furthest', async () => {
    const aligned = await sign(message({ body: 'Hallo' }), 'buero-muster.at', { maxBodyLength: 7 })
    const both = await sign(aligned, 'sendgrid.net')
    const verdict = await verdictOf(both, {
      ...keyFor('buero-muster.at'),
      ...keyFor('sendgrid.net'),
    })
    expect(verdict).toEqual({ verdict: 'fail', reason: 'dkim-body-length' })
  })

  it('admits when one signature qualifies and another does not', async () => {
    const aligned = await sign(message(), 'buero-muster.at')
    const both = await sign(aligned, 'sendgrid.net')
    const verdict = await verdictOf(both, {
      ...keyFor('buero-muster.at'),
      ...keyFor('sendgrid.net'),
    })
    expect(verdict).toMatchObject({ verdict: 'pass' })
  })
})

describe('verifySender: temperror, never a bounce (A6, B3)', () => {
  it('answers temperror when the key lookup times out (S8b, E)', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    expect(await verdictOf(raw, {}, ['sel._domainkey.buero-muster.at'])).toEqual({
      verdict: 'temperror',
      reason: 'dkim-temperror',
    })
  })

  it('answers fail, not temperror, when the timed-out signature could never admit the mail', async () => {
    const raw = await sign(message({ to: 'engineer@extern.at' }), 'buero-muster.at')
    expect(await verdictOf(raw, {}, ['sel._domainkey.buero-muster.at'])).toEqual({
      verdict: 'fail',
      reason: 'dkim-recipient',
    })
  })

  it('answers temperror when the resolver throws something unexpected', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const verdict = await verifySender(bytes(raw), {
      projectToken: TOKEN,
      resolver: () => {
        throw new TypeError('resolver bug')
      },
    })
    expect(verdict).toMatchObject({ verdict: 'temperror' })
  })

  it('answers temperror when DNS never answers', async () => {
    const raw = await sign(message(), 'buero-muster.at')
    const verdict = await verifySender(bytes(raw), {
      projectToken: TOKEN,
      resolver: () => new Promise(() => {}),
      deadlineMs: 50,
    })
    expect(verdict).toEqual({ verdict: 'temperror', reason: 'timeout' })
  })

  it('refuses garbage without throwing', async () => {
    const verdict = await verifySender(bytes('not a message at all'), {
      projectToken: TOKEN,
      resolver: fakeDns({}),
    })
    expect(verdict).toMatchObject({ verdict: 'fail' })
  })
})
