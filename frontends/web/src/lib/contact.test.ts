import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkToken,
  clientIp,
  createRateLimiter,
  handleContact,
  issueToken,
  MAX_AGE_MS,
  type Deps,
} from './contact.ts'

const SECRET = 'test-secret'
const NOW = 1_800_000_000_000
const ENV = {
  CONTACT_FORM_SECRET: SECRET,
  CLOUDFLARE_ACCOUNT_ID: 'acc123',
  CLOUDFLARE_EMAIL_TOKEN: 'cf-token',
  CONTACT_FORWARD_TO: 'a@example.com, b@example.com',
}
const FIELDS = {
  name: 'Anna Beispiel',
  email: 'anna@buero.example',
  office: 'Büro Beispiel',
  message: 'Gilt OIB-Richtlinie 2 für unser Stiegenhaus?',
  website: '',
  locale: 'de',
  page: '/',
}

type Call = { url: string; init: RequestInit }

function cloudflare(status = 200, body: object = { success: true, errors: [], result: { delivered: ['a@example.com'], queued: [] } }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function post(fields: Record<string, string>) {
  return new Request('http://localhost/api/kontakt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

const token = (age = 10_000) => issueToken(SECRET, NOW - age)

function deps(fetchImpl: typeof fetch, over: Partial<Deps> = {}): Deps {
  return { env: ENV, defaultFrom: 'kontakt@piloti.at', fetch: fetchImpl, ip: '203.0.113.7', now: NOW, limiter: createRateLimiter(), ...over }
}

test('a valid message is sent once, to the forward list, with the submitter as reply_to', async () => {
  const cf = cloudflare()
  const result = await handleContact(post({ ...FIELDS, token: token() }), deps(cf.fetchImpl))
  assert.equal(result.outcome, 'sent')
  assert.equal(result.status, 200)
  assert.equal(cf.calls.length, 1)
  assert.equal(cf.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send')
  assert.equal((cf.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer cf-token')
  const mail = JSON.parse(String(cf.calls[0].init.body))
  assert.deepEqual(mail.to, ['a@example.com', 'b@example.com'])
  assert.deepEqual(mail.from, { address: 'kontakt@piloti.at', name: 'Piloti Kontaktformular' })
  assert.equal(mail.reply_to, 'anna@buero.example')
  assert.equal(mail.subject, 'Kontaktformular: Anna Beispiel (Büro Beispiel)')
  assert.match(mail.text, /Nachricht:\nGilt OIB-Richtlinie 2/)
  assert.match(mail.text, /Sprache: de\nSeite: \//)
  assert.doesNotMatch(mail.text, /203\.0\.113\.7/)
})

test('a line break in the name cannot reach the subject', async () => {
  const cf = cloudflare()
  await handleContact(post({ ...FIELDS, name: 'Anna\r\nBcc: x@example.com', office: '', token: token() }), deps(cf.fetchImpl))
  const mail = JSON.parse(String(cf.calls[0].init.body))
  assert.equal(mail.subject, 'Kontaktformular: Anna Bcc: x@example.com')
})

test('a filled honeypot is refused and nothing is sent', async () => {
  const cf = cloudflare()
  const result = await handleContact(post({ ...FIELDS, website: 'https://spam.example', token: token() }), deps(cf.fetchImpl))
  assert.equal(result.outcome, 'spam')
  assert.equal(result.status, 400)
  assert.equal(cf.calls.length, 0)
})

test('a form sent within 3 s of being handed out is refused', async () => {
  const cf = cloudflare()
  const result = await handleContact(post({ ...FIELDS, token: token(1_000) }), deps(cf.fetchImpl))
  assert.equal(result.outcome, 'too_fast')
  assert.equal(result.status, 400)
  assert.equal(cf.calls.length, 0)
})

test('a forged, missing or expired timestamp is refused', async () => {
  const cf = cloudflare()
  const forged = `${NOW - 10_000}.${'A'.repeat(43)}`
  assert.equal((await handleContact(post({ ...FIELDS, token: forged }), deps(cf.fetchImpl))).outcome, 'token_invalid')
  assert.equal((await handleContact(post({ ...FIELDS, token: issueToken('other', NOW - 10_000) }), deps(cf.fetchImpl))).outcome, 'token_invalid')
  assert.equal((await handleContact(post({ ...FIELDS }), deps(cf.fetchImpl))).outcome, 'token_missing')
  assert.equal((await handleContact(post({ ...FIELDS, token: token(MAX_AGE_MS + 1) }), deps(cf.fetchImpl))).outcome, 'token_expired')
  assert.equal(cf.calls.length, 0)
})

test('the sixth message from one address in ten minutes is refused', async () => {
  const cf = cloudflare()
  const limiter = createRateLimiter()
  const outcomes = []
  for (let i = 0; i < 6; i++) {
    outcomes.push((await handleContact(post({ ...FIELDS, token: token() }), deps(cf.fetchImpl, { limiter }))).outcome)
  }
  assert.deepEqual(outcomes, ['sent', 'sent', 'sent', 'sent', 'sent', 'rate_limited'])
  const other = await handleContact(post({ ...FIELDS, token: token() }), deps(cf.fetchImpl, { limiter, ip: '198.51.100.1' }))
  assert.equal(other.outcome, 'sent')
  const later = await handleContact(post({ ...FIELDS, token: issueToken(SECRET, NOW + 600_000) }), deps(cf.fetchImpl, { limiter, now: NOW + 610_001 }))
  assert.equal(later.outcome, 'sent')
})

test('a Cloudflare error answers 502 and keeps what was entered', async () => {
  const cf = cloudflare(403, { success: false, errors: [{ code: 10102, message: 'forbidden' }], result: null })
  const result = await handleContact(post({ ...FIELDS, token: token() }), deps(cf.fetchImpl))
  assert.equal(result.outcome, 'upstream')
  assert.equal(result.status, 502)
  assert.equal(result.values?.message, FIELDS.message)
})

test('a network failure or an all-bounced send answers 502', async () => {
  const down = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  assert.equal((await handleContact(post({ ...FIELDS, token: token() }), deps(down))).status, 502)
  const bounced = cloudflare(200, { success: true, errors: [], result: { delivered: [], queued: [], permanent_bounces: ['a@example.com'] } })
  assert.equal((await handleContact(post({ ...FIELDS, token: token() }), deps(bounced.fetchImpl))).status, 502)
})

test('missing configuration answers 503 without calling out', async () => {
  const cf = cloudflare()
  for (const missing of ['CONTACT_FORM_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_TOKEN', 'CONTACT_FORWARD_TO']) {
    const env = { ...ENV, [missing]: undefined }
    const result = await handleContact(post({ ...FIELDS, token: token() }), deps(cf.fetchImpl, { env }))
    assert.equal(result.status, 503, missing)
  }
  assert.equal(cf.calls.length, 0)
})

test('invalid fields answer 422 with one error per field', async () => {
  const cf = cloudflare()
  const result = await handleContact(
    post({ ...FIELDS, name: '  ', email: 'not-an-address', office: 'x'.repeat(161), token: token() }),
    deps(cf.fetchImpl),
  )
  assert.equal(result.status, 422)
  assert.deepEqual(result.fields, { name: 'required', email: 'email', office: 'too_long' })
  assert.equal(cf.calls.length, 0)
})

test('a body past the bound is refused before it is parsed', async () => {
  const cf = cloudflare()
  const result = await handleContact(post({ ...FIELDS, message: 'x'.repeat(40_000), token: token() }), deps(cf.fetchImpl))
  assert.equal(result.status, 413)
})

test('the signature is checked in constant shape and ages are bounded', () => {
  assert.equal(checkToken(issueToken(SECRET, NOW - 5_000), SECRET, NOW), 'ok')
  assert.equal(checkToken(issueToken(SECRET, NOW + 5_000), SECRET, NOW), 'too_fast')
  assert.equal(checkToken('garbage', SECRET, NOW), 'token_invalid')
})

test('the client address is the entry the gateway appended, not one the client sent', () => {
  const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })
  assert.equal(clientIp(headers, '10.0.0.5'), '203.0.113.7')
  assert.equal(clientIp(new Headers(), '10.0.0.5'), '10.0.0.5')
})
