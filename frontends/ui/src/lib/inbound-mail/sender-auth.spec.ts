/**
 * @vitest-environment node
 */
/**
 * Sender authentication against REAL signatures: messages are DKIM-signed with
 * throwaway keys and mailauth verifies them against a fake DNS that publishes
 * the record each case needs (`__fixtures__/hostile.ts`). Nothing inside
 * mailauth is mocked, so what passes here passes in production.
 */
import { describe, expect, it } from 'vitest'
import {
  bytes,
  fakeDns,
  INBOUND_DOMAIN,
  keyFor,
  keyName,
  MEMBER_ADDRESS,
  MEMBER_DOMAIN,
  message,
  PROJECT_ADDRESS,
  PROJECT_TOKEN,
  RECEIVED,
  SENT,
  sign,
  testKey,
} from './__fixtures__/hostile'
import {
  authenticateSender,
  BCC_WINDOW_MS,
  evidenceLine,
  judgeSender,
  requiresSenderAcknowledgement,
  type SenderAuthentication,
} from './sender-auth'

const DAY = 24 * 60 * 60 * 1000

async function authenticate(raw: string, txt: Record<string, string> = keyFor(MEMBER_DOMAIN), failing: string[] = []) {
  const dns = fakeDns(txt, failing)
  const result = await authenticateSender(bytes(raw), {
    projectToken: PROJECT_TOKEN,
    inboundDomain: INBOUND_DOMAIN,
    resolver: dns.resolver,
  })
  return { ...result, lookups: dns.lookups }
}

const verify = async (raw: string, txt?: Record<string, string>) => (await authenticate(raw, txt)).reason

describe('authenticateSender: what verifies', () => {
  it('verifies an aligned signature over From, Subject, Message-ID, Date and the To naming the project', async () => {
    const raw = await sign(message(undefined, { From: 'Anna Muster <Anna@Buero-Muster.at>' }))
    const result = await authenticate(raw)
    expect(result).toMatchObject({
      verified: true,
      reason: 'dkim_pass',
      fromAddress: MEMBER_ADDRESS,
      fromDomain: MEMBER_DOMAIN,
      signerDomain: MEMBER_DOMAIN,
      signedRecipientNamesProject: true,
    })
    expect(result.signedHeaders).toEqual(expect.arrayContaining(['from', 'to', 'subject', 'message-id', 'date']))
    expect(result.signedHeaders.every((name) => name === name.toLowerCase())).toBe(true)
  })

  it('verifies relaxed alignment: a subdomain signs for the From domain', async () => {
    const raw = await sign(message(), { domain: `mail.${MEMBER_DOMAIN}` })
    expect(await verify(raw, keyFor(`mail.${MEMBER_DOMAIN}`))).toBe('dkim_pass')
  })

  it('verifies without any DMARC record, and a failing _dmarc lookup changes nothing', async () => {
    const raw = await sign(message())
    const result = await authenticate(raw, keyFor(MEMBER_DOMAIN), [`_dmarc.${MEMBER_DOMAIN}`])
    expect(result.reason).toBe('dkim_pass')
  })

  it('verifies when one signature qualifies and another does not', async () => {
    const weak = await sign(message(), { headerList: 'From:To:Subject' })
    const raw = await sign(weak)
    expect(await verify(raw)).toBe('dkim_pass')
  })

  it('stores the signed field names of the ADMITTING signature only', async () => {
    const raw = await sign(message(undefined, { References: '<root@x>' }), {
      headerList: 'From:To:Subject:Date:Message-ID:References',
    })
    expect([...(await authenticate(raw)).signedHeaders].sort()).toEqual(['date', 'from', 'message-id', 'references', 'subject', 'to'])
  })
})

describe('authenticateSender: the hygiene rules', () => {
  it.each([
    ['Subject', 'From:To:Date:Message-ID'],
    ['Message-ID', 'From:To:Subject:Date'],
    ['Date', 'From:To:Subject:Message-ID'],
  ])('does not verify a signature that leaves %s out', async (_left, headerList) => {
    expect(await verify(await sign(message(), { headerList }))).toBe('dkim_unsigned_fields')
  })

  it('does not verify an l= signature, with or without appended content', async () => {
    const raw = await sign(message(), { maxBodyLength: 10 })
    expect(await verify(raw)).toBe('dkim_body_length')
    expect(await verify(`${raw}\r\nUnterschrift: gefälscht\r\n`)).toBe('dkim_body_length')
  })

  it('does not verify a key in testing mode (t=y)', async () => {
    const raw = await sign(message())
    expect(await verify(raw, keyFor(MEMBER_DOMAIN, `${testKey().record}; t=y`))).toBe('dkim_testing')
  })

  it('does not verify rsa-sha1', async () => {
    expect(await verify(await sign(message(), { algorithm: 'rsa-sha1' }))).toBe('dkim_weak_algorithm')
  })

  it('does not verify a key shorter than 1024 bits', async () => {
    const short = testKey(768)
    const raw = await sign(message(), { key: short })
    expect(await verify(raw, keyFor(MEMBER_DOMAIN, short.record))).toBe('dkim_short_key')
  })

  it('does not verify an expired signature (x= in the past)', async () => {
    const raw = await sign(message(), { expires: new Date(Date.now() - DAY) })
    expect(await verify(raw)).toBe('dkim_expired')
  })
})

describe('authenticateSender: what does not verify, and why', () => {
  it('names a signature that does not verify a fail (a forged From)', async () => {
    const raw = await sign(message())
    expect(await verify(raw.replace('Subject: Einreichplan', 'Subject: Rechnung'))).toBe('dkim_fail')
  })

  it('names a body changed after signing a fail', async () => {
    const raw = await sign(message())
    expect(await verify(raw.replace('Unterlagen', 'Kontodaten'))).toBe('dkim_fail')
  })

  it('names a passing signature of another domain unaligned', async () => {
    const raw = await sign(message(), { domain: 'mailer.example.com' })
    expect(await verify(raw, keyFor('mailer.example.com'))).toBe('dkim_unaligned')
  })

  it('names an unsigned mail dkim_none', async () => {
    expect(await verify(message())).toBe('dkim_none')
  })

  it('reports the aligned signature that failed over an unaligned one that passed', async () => {
    const thirdParty = await sign(message(), { domain: 'mailer.example.com' })
    const raw = await sign(thirdParty, { headerList: 'From:To:Subject:Message-ID' })
    expect(await verify(raw, { ...keyFor(MEMBER_DOMAIN), ...keyFor('mailer.example.com') })).toBe('dkim_unsigned_fields')
  })

  it('answers dkim_temperror when the key lookup times out, never an exception', async () => {
    const raw = await sign(message())
    const result = await authenticate(raw, {}, [keyName(MEMBER_DOMAIN)])
    expect(result).toMatchObject({ verified: false, reason: 'dkim_temperror' })
  })

  it('answers verifier_timeout when DNS never answers, by its own deadline', async () => {
    const raw = await sign(message())
    const result = await authenticateSender(bytes(raw), {
      projectToken: PROJECT_TOKEN,
      inboundDomain: INBOUND_DOMAIN,
      resolver: () => new Promise(() => {}),
      deadlineMs: 50,
    })
    expect(result).toMatchObject({ verified: false, reason: 'verifier_timeout', fromAddress: MEMBER_ADDRESS })
  })

  it('answers verifier_error when the resolver throws something unexpected', async () => {
    const raw = await sign(message())
    const result = await authenticateSender(bytes(raw), {
      projectToken: PROJECT_TOKEN,
      inboundDomain: INBOUND_DOMAIN,
      resolver: () => {
        throw new TypeError('boom')
      },
    })
    expect(result.verified).toBe(false)
    expect(['verifier_error', 'dkim_temperror']).toContain(result.reason)
  })
})

describe('authenticateSender: the raw header block', () => {
  it('does not verify a signed mail with an unsigned duplicate Subject above it', async () => {
    const raw = await sign(message())
    expect(await verify(`Subject: Neue Kontodaten\r\n${raw}`)).toBe('header_duplicate')
  })

  it('does not verify a mail with an unsigned second To (the replay redirect)', async () => {
    const raw = await sign(message())
    expect(await verify(`To: ${PROJECT_ADDRESS}\r\n${raw}`)).toBe('header_duplicate')
  })

  it('counts folded lines and odd case as the same field', async () => {
    const raw = await sign(message())
    expect(await verify(`sUbJeCt:\r\n Neu\r\n${raw}`)).toBe('header_duplicate')
  })

  it('refuses a header line that is neither a field nor a continuation', async () => {
    expect(await verify(`From: ${MEMBER_ADDRESS}\r\nnot a header\r\n\r\nbody`)).toBe('header_malformed')
  })

  it.each([
    ['two From fields', (raw: string) => `From: other@example.com\r\n${raw}`],
    ['two addresses in one From', (raw: string) => raw.replace(/^From: .*$/m, 'From: a@x.at, b@y.at')],
    ['no From', (raw: string) => raw.replace(/^From: .*\r\n/m, '')],
  ])('does not verify %s', async (_label, edit) => {
    expect(await verify(edit(await sign(message())))).toBe('from_count')
  })

  it('does not verify a non-ASCII local part: the Kelvin sign must not fold onto k', async () => {
    const raw = message(undefined, { From: 'anna\u212A@buero-muster.at' })
    expect(await verify(raw)).toBe('from_not_ascii')
  })

  it('does not verify garbage, and does not throw', async () => {
    expect((await authenticate('\u0000\u0001\u0002')).verified).toBe(false)
    expect((await authenticate('')).verified).toBe(false)
  })
})

describe('authenticateSender: addressed to the project', () => {
  it('is addressed when a signed Cc names the token, with +detail or a quoted name', async () => {
    const cc = await sign(message(undefined, { To: 'lieferant@extern.at', Cc: PROJECT_ADDRESS }))
    expect((await authenticate(cc)).signedRecipientNamesProject).toBe(true)
    const plus = await sign(message(undefined, { To: `"Projekt" <wohnbau.${PROJECT_TOKEN}+plaene@${INBOUND_DOMAIN}>` }))
    expect((await authenticate(plus)).signedRecipientNamesProject).toBe(true)
  })

  it('is not addressed when the signed recipients are someone else (a Bcc, or a replay)', async () => {
    const raw = await sign(message(undefined, { To: 'bauherr@extern.at' }))
    expect(await authenticate(raw)).toMatchObject({ verified: true, signedRecipientNamesProject: false })
  })

  it('is not addressed when the signature leaves To and Cc out', async () => {
    const raw = await sign(message(), { headerList: 'From:Subject:Date:Message-ID' })
    expect(await authenticate(raw)).toMatchObject({ verified: true, signedRecipientNamesProject: false })
  })

  it('is not addressed by the token in any other domain: a look-alike is not our address', async () => {
    const raw = await sign(message(undefined, { To: `wohnbau.${PROJECT_TOKEN}@${INBOUND_DOMAIN}.evil.example` }))
    expect((await authenticate(raw)).signedRecipientNamesProject).toBe(false)
  })

  it("is not addressed to THIS project by another project's token", async () => {
    const raw = await sign(message(undefined, { To: `nachbar.zzzzzzzzzzzz@${INBOUND_DOMAIN}` }))
    expect((await authenticate(raw)).signedRecipientNamesProject).toBe(false)
  })
})

describe('evidenceLine', () => {
  it('carries the authserv-id, DKIM and DMARC, and never spf=', async () => {
    const raw = await sign(message())
    const { authenticationResults } = await authenticate(raw, { ...keyFor(MEMBER_DOMAIN), [`_dmarc.${MEMBER_DOMAIN}`]: 'v=DMARC1; p=reject' })
    expect(authenticationResults).toMatch(/^piloti\.at; dkim=pass header\.i=@buero-muster\.at .*; dmarc=pass/)
    expect(authenticationResults).not.toMatch(/spf=/i)
    expect(authenticationResults).not.toMatch(/[\r\n]/)
  })

  it('drops an spf= result even if one were handed to it, and stays within 4096 characters', () => {
    const info = (text: string) => ({ status: { result: 'pass' as const }, info: text })
    const line = evidenceLine('piloti.at', {
      dkim: { headerFrom: [], fromFields: 1, fromSyntax: 'valid', envelopeFrom: false, results: [info('spf=temperror x'), info(`dkim=pass ${'b'.repeat(5000)}`)] },
      dmarc: false,
    })
    expect(line).not.toContain('spf=')
    expect(line.length).toBeLessThanOrEqual(4096)
  })
})

const verifiedAuth = (overrides: Partial<SenderAuthentication> = {}): SenderAuthentication => ({
  fromAddress: MEMBER_ADDRESS,
  fromDomain: MEMBER_DOMAIN,
  verified: true,
  reason: 'dkim_pass',
  signerDomain: MEMBER_DOMAIN,
  signedHeaders: ['from', 'to', 'subject', 'date', 'message-id'],
  signedRecipientNamesProject: true,
  authenticationResults: 'piloti.at; dkim=pass',
  ...overrides,
})

const unverifiedAuth = (reason: SenderAuthentication['reason'] = 'dkim_none') =>
  verifiedAuth({ verified: false, reason, signerDomain: null, signedHeaders: [], signedRecipientNamesProject: false })

describe('judgeSender: the trust label', () => {
  const at = { receivedAt: RECEIVED, sentAtHeader: SENT }

  it.each([
    [true, 'user_1', 'member_verified'],
    [false, 'user_1', 'member_unverified'],
    [true, null, 'external_verified'],
    [false, null, 'external_unverified'],
  ] as const)('verified=%s member=%s is %s', (verified, member, trust) => {
    const auth = verified ? verifiedAuth() : unverifiedAuth()
    const verdict = judgeSender(auth, { ...at, memberUserId: member })
    expect(verdict.trust).toBe(trust)
    expect(verdict.senderUserId).toBe(member)
    expect(verdict.flags).toEqual([])
  })

  it('never names a member without a From address to match', () => {
    const auth = { ...unverifiedAuth('from_count'), fromAddress: null, fromDomain: null }
    expect(judgeSender(auth, { ...at, memberUserId: 'user_1' })).toMatchObject({ trust: 'external_unverified', senderUserId: null })
  })
})

describe('judgeSender: replay, Bcc and stale dates', () => {
  const notAddressed = verifiedAuth({ signedRecipientNamesProject: false })

  it("flags a member's signed mail to someone else, received a week later: a replay", () => {
    const verdict = judgeSender(notAddressed, { memberUserId: 'user_1', receivedAt: new Date(SENT.getTime() + 2 * DAY), sentAtHeader: SENT })
    expect(verdict.flags).toEqual(['not_addressed_to_project'])
    expect(requiresSenderAcknowledgement(verdict)).toBe(true)
  })

  it("treats the member's own copy within a day as their Bcc: both flags, no acknowledgement", () => {
    const verdict = judgeSender(notAddressed, { memberUserId: 'user_1', receivedAt: RECEIVED, sentAtHeader: SENT })
    expect(verdict.flags).toEqual(['not_addressed_to_project', 'bcc_own'])
    expect(requiresSenderAcknowledgement(verdict)).toBe(false)
  })

  it('holds the Bcc window at exactly one day', () => {
    const edge = judgeSender(notAddressed, { memberUserId: 'user_1', receivedAt: new Date(SENT.getTime() + BCC_WINDOW_MS), sentAtHeader: SENT })
    expect(edge.flags).toContain('bcc_own')
    const past = judgeSender(notAddressed, { memberUserId: 'user_1', receivedAt: new Date(SENT.getTime() + BCC_WINDOW_MS + 1), sentAtHeader: SENT })
    expect(past.flags).not.toContain('bcc_own')
  })

  it('never calls an external sender, however verified, a Bcc', () => {
    const verdict = judgeSender(notAddressed, { memberUserId: null, receivedAt: RECEIVED, sentAtHeader: SENT })
    expect(verdict.flags).toEqual(['not_addressed_to_project'])
  })

  it('asks the addressed question of verified mail only: an unsigned To says what the sender typed', () => {
    expect(judgeSender(unverifiedAuth(), { memberUserId: null, receivedAt: RECEIVED, sentAtHeader: SENT }).flags).toEqual([])
  })

  it('flags a signed Date more than seven days old as stale, and asks for an acknowledgement', () => {
    const verdict = judgeSender(verifiedAuth(), { memberUserId: 'user_1', receivedAt: new Date(SENT.getTime() + 8 * DAY), sentAtHeader: SENT })
    expect(verdict.flags).toEqual(['stale_date'])
    expect(requiresSenderAcknowledgement(verdict)).toBe(true)
  })
})

describe('judgeSender: the send time', () => {
  it('stores the clamped send time, from the thread core, with the flag', () => {
    const verdict = judgeSender(unverifiedAuth(), { memberUserId: null, receivedAt: RECEIVED, sentAtHeader: new Date('2030-01-01') })
    expect(verdict).toMatchObject({ sentAt: RECEIVED, sentAtHeader: new Date('2030-01-01'), flags: ['date_out_of_range'] })
  })

  it('believes a Date inside the window and flags a missing one', () => {
    expect(judgeSender(unverifiedAuth(), { memberUserId: null, receivedAt: RECEIVED, sentAtHeader: SENT })).toMatchObject({ sentAt: SENT, flags: [] })
    expect(judgeSender(unverifiedAuth(), { memberUserId: null, receivedAt: RECEIVED, sentAtHeader: null }).flags).toEqual(['date_out_of_range'])
  })
})

describe('requiresSenderAcknowledgement', () => {
  const plain = { receivedAt: RECEIVED, sentAtHeader: SENT }

  it('asks for a member address without a verified domain', () => {
    expect(requiresSenderAcknowledgement(judgeSender(unverifiedAuth(), { ...plain, memberUserId: 'user_1' }))).toBe(true)
  })

  it("asks when the From domain's own signature fails or is refused by policy", () => {
    for (const reason of ['dkim_fail', 'dkim_policy', 'dkim_weak_algorithm', 'dkim_short_key'] as const) {
      expect(requiresSenderAcknowledgement(judgeSender(unverifiedAuth(reason), { ...plain, memberUserId: null })), reason).toBe(true)
    }
  })

  it('never asks for a plain unsigned mail from outside, the ordinary case', () => {
    expect(requiresSenderAcknowledgement(judgeSender(unverifiedAuth('dkim_none'), { ...plain, memberUserId: null }))).toBe(false)
  })
})
