/**
 * The contact form's server side: one function, `handleContact`, that both
 * routes call (`pages/api/kontakt.ts` for the enhanced form, `pages/kontakt.astro`
 * for a browser without script), and the pieces it is made of.
 *
 * Nothing here is stored. A valid message is sent once, through Cloudflare's
 * Email Service REST API, to the founders' verified addresses; the reply goes
 * from their own mail client to the submitter (`reply_to`). No log line carries
 * a field, the address or the IP: only an outcome code.
 *
 * Spam protection needs no third-party script: a honeypot field, a signed
 * timestamp (HMAC over the time the form was handed out, keyed by
 * `CONTACT_FORM_SECRET`: at least 3 s and at most 24 h old), a per-IP rate
 * limit held in memory, and a bounded body.
 *
 * Pure apart from `console` and the injected `fetch`, so `node --test` runs it
 * without Astro (`contact.test.ts`). Imports carry `.ts` for that reason.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'astro/zod'

/** Field limits, shared by the form's `maxlength` and the server schema. */
export const LIMITS = { name: 120, email: 254, office: 160, message: 5000 } as const

export const MIN_AGE_MS = 3_000
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
export const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 } as const
/** The four fields at their limits, URL-encoded (up to 3× for UTF-8), plus the hidden ones. */
export const MAX_BODY_BYTES = 32 * 1024

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

export type Outcome =
  | 'sent'
  | 'invalid'
  | 'config'
  | 'too_large'
  | 'rate_limited'
  | 'spam'
  | 'token_missing'
  | 'token_invalid'
  | 'too_fast'
  | 'token_expired'
  | 'upstream'

export const STATUS: Record<Outcome, number> = {
  sent: 200,
  invalid: 422,
  config: 503,
  too_large: 413,
  rate_limited: 429,
  spam: 400,
  token_missing: 400,
  token_invalid: 400,
  too_fast: 400,
  token_expired: 400,
  upstream: 502,
}

export type FieldName = 'name' | 'email' | 'office' | 'message'
export type FieldError = 'required' | 'email' | 'too_long'
export type Values = Record<FieldName, string>

export interface Result {
  outcome: Outcome
  status: number
  /** Field errors, for `invalid`. */
  fields?: Partial<Record<FieldName, FieldError>>
  /** What was entered, so a page rendered without script can show it again. */
  values?: Values
}

export interface Config {
  secret: string
  accountId: string
  token: string
  to: string[]
  from: string
}

// ── Configuration ─────────────────────────────────────────────────────────────

const emailSchema = z.email().max(LIMITS.email)

/**
 * The five variables, or `undefined` when one the send needs is missing. Unset
 * is not an error at boot: the site renders without them (local dev), and the
 * form answers 503 with the mail address instead.
 */
export function readConfig(env: Record<string, string | undefined>, defaultFrom: string): Config | undefined {
  const secret = env.CONTACT_FORM_SECRET?.trim()
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const token = env.CLOUDFLARE_EMAIL_TOKEN?.trim()
  const to = (env.CONTACT_FORWARD_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => emailSchema.safeParse(s).success)
  const from = env.CONTACT_FROM?.trim() || defaultFrom
  if (!secret || !accountId || !token || to.length === 0) return undefined
  return { secret, accountId, token, to, from }
}

// ── The signed timestamp ──────────────────────────────────────────────────────

const sign = (secret: string, issuedAt: number) =>
  createHmac('sha256', secret).update(`piloti-contact:${issuedAt}`).digest('base64url')

/** `<ms since epoch>.<HMAC>`, handed out with the form. */
export function issueToken(secret: string, now = Date.now()) {
  return `${now}.${sign(secret, now)}`
}

export type TokenCheck = 'ok' | 'token_missing' | 'token_invalid' | 'too_fast' | 'token_expired'

export function checkToken(token: string | null, secret: string, now = Date.now()): TokenCheck {
  if (!token) return 'token_missing'
  const match = /^(\d{1,15})\.([\w-]{43})$/.exec(token)
  if (!match) return 'token_invalid'
  const issuedAt = Number(match[1])
  const given = Buffer.from(match[2])
  const expected = Buffer.from(sign(secret, issuedAt))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'token_invalid'
  const age = now - issuedAt
  if (age < MIN_AGE_MS) return 'too_fast'
  if (age > MAX_AGE_MS) return 'token_expired'
  return 'ok'
}

// ── Rate limit ────────────────────────────────────────────────────────────────

/**
 * A fixed window per client, in this process's memory. The key is an HMAC of
 * the IP, so the map never holds an address; it forgets a key when its window
 * ends. Per pod: two replicas allow twice the budget, which is still a bound.
 */
export function createRateLimiter(max: number = RATE_LIMIT.max, windowMs: number = RATE_LIMIT.windowMs) {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return (key: string, now = Date.now()) => {
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
    }
    const w = windows.get(key)
    if (!w || w.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    w.count += 1
    return w.count <= max
  }
}

const defaultLimiter = createRateLimiter()

/**
 * The visitor's address. Behind the gateway, the socket is Envoy's, and Astro
 * ignores `X-Forwarded-For` unless `security.allowedDomains` is set. Envoy
 * appends the address it accepted the connection from as the LAST entry
 * (`clientIPDetection` in deploy/pulumi/src/platform/gateway.ts); earlier
 * entries are whatever the client sent, so the last one is the one to trust.
 */
export function clientIp(headers: Headers, socketAddress: string | undefined) {
  const last = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
  return last || socketAddress || 'unknown'
}

// ── Validation ────────────────────────────────────────────────────────────────

/** One line: a name or an office never carries a line break into the subject. */
const oneLine = (s: string) => s.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()

const schema = z.object({
  name: z.string().transform(oneLine).pipe(z.string().min(1).max(LIMITS.name)),
  email: z.string().trim().pipe(z.string().min(1).max(LIMITS.email).pipe(z.email())),
  office: z.string().transform(oneLine).pipe(z.string().max(LIMITS.office)),
  message: z
    .string()
    .transform((s) => s.replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().min(1).max(LIMITS.message)),
})

function fieldError(issue: z.core.$ZodIssue): FieldError {
  if (issue.code === 'too_big') return 'too_long'
  if (issue.code === 'too_small') return 'required'
  return 'email'
}

export function validate(values: Values) {
  const parsed = schema.safeParse(values)
  if (parsed.success) return { ok: true as const, data: parsed.data }
  const fields: Partial<Record<FieldName, FieldError>> = {}
  for (const issue of parsed.error.issues) {
    const name = issue.path[0] as FieldName
    fields[name] ??= fieldError(issue)
  }
  return { ok: false as const, fields }
}

// ── The mail ──────────────────────────────────────────────────────────────────

export interface Meta {
  locale: 'de' | 'en'
  page: string
}

/** The request body of `POST /accounts/{id}/email/sending/send`. */
export function buildMail(config: Config, data: Values, meta: Meta) {
  const subject = `Kontaktformular: ${data.name}${data.office ? ` (${data.office})` : ''}`
  const text = [
    `Name: ${data.name}`,
    `E-Mail: ${data.email}`,
    `Büro/Firma: ${data.office || '–'}`,
    `Sprache: ${meta.locale}`,
    `Seite: ${meta.page}`,
    '',
    'Nachricht:',
    data.message,
    '',
    '–',
    'Gesendet über das Kontaktformular auf piloti.at. Antworten gehen an die Absenderin oder den Absender.',
  ].join('\n')
  return {
    to: config.to,
    from: { address: config.from, name: 'Piloti Kontaktformular' },
    reply_to: data.email,
    subject,
    text,
  }
}

/** Sends the mail; `true` only when Cloudflare accepted it for at least one recipient. */
export async function sendMail(config: Config, mail: ReturnType<typeof buildMail>, fetchImpl: typeof fetch) {
  const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    console.warn('[kontakt] outcome=upstream reason=network')
    return false
  }
  const body = (await res.json().catch(() => null)) as CloudflareResponse | null
  const accepted = (body?.result?.delivered?.length ?? 0) + (body?.result?.queued?.length ?? 0)
  if (res.ok && body?.success === true && (accepted > 0 || !body.result)) return true
  const codes = body?.errors?.map((e) => e.code).join(',') || 'none'
  console.warn(`[kontakt] outcome=upstream http=${res.status} cf=${codes} accepted=${accepted}`)
  return false
}

interface CloudflareResponse {
  success?: boolean
  errors?: { code?: number }[]
  result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } | null
}

// ── The request ───────────────────────────────────────────────────────────────

/** The body as form fields, or `undefined` past `max` bytes, however it arrives. */
export async function readForm(request: Request, max = MAX_BODY_BYTES) {
  if (Number(request.headers.get('content-length') ?? 0) > max) return undefined
  if (!request.body) return new URLSearchParams()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export interface Deps {
  env: Record<string, string | undefined>
  defaultFrom: string
  fetch: typeof fetch
  ip: string
  now?: number
  limiter?: (key: string, now?: number) => boolean
}

const pick = (form: URLSearchParams): Values => ({
  name: form.get('name') ?? '',
  email: form.get('email') ?? '',
  office: form.get('office') ?? '',
  message: form.get('message') ?? '',
})

const localeOf = (form: URLSearchParams): 'de' | 'en' => (form.get('locale') === 'en' ? 'en' : 'de')
const pageOf = (form: URLSearchParams) => {
  const page = form.get('page') ?? ''
  return /^\/[\w\-/.#]{0,200}$/.test(page) ? page : '/'
}

function done(outcome: Outcome, extra: Partial<Result> = {}): Result {
  // The one log line: an outcome code, never a field, an address or an IP.
  if (outcome !== 'upstream') console.info(`[kontakt] outcome=${outcome}`)
  return { outcome, status: STATUS[outcome], ...extra }
}

/** Every check in order, then the send. Both routes turn the result into their own response. */
export async function handleContact(request: Request, deps: Deps): Promise<Result> {
  const now = deps.now ?? Date.now()
  const config = readConfig(deps.env, deps.defaultFrom)
  const form = await readForm(request)
  if (!form) return done('too_large')
  const values = pick(form)
  if (!config) return done('config', { values })
  const key = createHmac('sha256', config.secret).update(deps.ip).digest('base64url')
  if (!(deps.limiter ?? defaultLimiter)(key, now)) return done('rate_limited', { values })
  if (form.get('website')) return done('spam')
  const token = checkToken(form.get('token'), config.secret, now)
  if (token !== 'ok') return done(token, { values })
  const checked = validate(values)
  if (!checked.ok) return done('invalid', { values, fields: checked.fields })
  const mail = buildMail(config, checked.data, { locale: localeOf(form), page: pageOf(form) })
  if (!(await sendMail(config, mail, deps.fetch))) return done('upstream', { values })
  return done('sent')
}
