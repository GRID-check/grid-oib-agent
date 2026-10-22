/**
 * The hostile corpus and the builders behind it, generated in code: no binary
 * is committed, every byte is made here at test time, and EICAR is assembled
 * from two halves so the file itself never carries the test string.
 *
 * Messages are DKIM-signed for real with throwaway keys and verified by mailauth
 * against a fake DNS ({@link fakeDns}) that publishes the record each case
 * needs, so what passes in a spec passes in production. Nothing inside mailauth,
 * postal-mime or file-type is mocked.
 *
 * Used by `sender-auth.spec.ts`, `mime.spec.ts`, `automatic-mail.spec.ts` and
 * `hostile.spec.ts`. Test-only; nothing in production imports it.
 */

import { generateKeyPairSync } from 'node:crypto'
import { dkimSign, type DKIMSignOptions, type DNSResolver } from 'mailauth'

// ---------------------------------------------------------------------------
// Keys and DNS
// ---------------------------------------------------------------------------

export interface TestKey {
  privatePem: string
  /** The DKIM key record (`v=DKIM1; k=rsa; p=…`). */
  record: string
}

const keys = new Map<number, TestKey>()

/** An RSA key of `bits`, made once per run and size. */
export function testKey(bits = 2048): TestKey {
  const cached = keys.get(bits)
  if (cached) return cached
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  const key = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    record: `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`,
  }
  keys.set(bits, key)
  return key
}

/** The TXT record name of a selector. */
export const keyName = (domain: string, selector = 'sel') => `${selector}._domainkey.${domain}`

/** `{ <selector>._domainkey.<domain>: record }` for the default 2048-bit key. */
export function keyFor(domain: string, record = testKey().record, selector = 'sel'): Record<string, string> {
  return { [keyName(domain, selector)]: record }
}

export interface FakeDns {
  resolver: DNSResolver
  /** Every lookup, `name TYPE`, in order. A budget counts these. */
  lookups: string[]
}

/** TXT answers by name; `failing` names time out; anything else is NXDOMAIN. */
export function fakeDns(txt: Record<string, string>, failing: readonly string[] = []): FakeDns {
  const lookups: string[] = []
  const resolver: DNSResolver = async (name, rrtype) => {
    const lower = name.toLowerCase()
    lookups.push(`${lower} ${rrtype}`)
    if (failing.includes(lower)) throw Object.assign(new Error('ETIMEOUT (fake dns)'), { code: 'ETIMEOUT' })
    const value = rrtype === 'TXT' ? txt[lower] : undefined
    if (value === undefined) throw Object.assign(new Error('ENOTFOUND (fake dns)'), { code: 'ENOTFOUND' })
    return [[value]]
  }
  return { resolver, lookups }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const INBOUND_DOMAIN = 'piloti.at'
export const PROJECT_TOKEN = 'abcdefgh2345'
export const PROJECT_ADDRESS = `wohnbau.${PROJECT_TOKEN}@${INBOUND_DOMAIN}`
export const OTHER_TENANT_ADDRESS = `nachbar.zzzzzzzzzzzz@${INBOUND_DOMAIN}`
export const MEMBER = 'Anna Muster <anna@buero-muster.at>'
export const MEMBER_ADDRESS = 'anna@buero-muster.at'
export const MEMBER_DOMAIN = 'buero-muster.at'

/** The send time every builder writes, and a receipt a quarter of an hour later. */
export const SENT = new Date('2026-09-28T10:15:00+02:00')
export const RECEIVED = new Date(SENT.getTime() + 15 * 60 * 1000)
export const SENT_HEADER = 'Mon, 28 Sep 2026 10:15:00 +0200'

/** One MIME entity: its header lines and its body. */
export interface Part {
  headers: string[]
  body: string
}

/** Base64 in 76-character lines, as mailers write it. */
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n')

/** A leaf part carrying `bytes` in base64. */
export function filePart(type: string, bytes: Uint8Array, extra: string[] = []): Part {
  return { headers: [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra], body: b64(bytes) }
}

/** An attachment by name. */
export const attachment = (name: string, type: string, bytes: Uint8Array) =>
  filePart(type, bytes, [`Content-Disposition: attachment; filename="${name}"`])

export function textPart(type: string, body: string, extra: string[] = []): Part {
  return { headers: [`Content-Type: ${type}; charset=utf-8`, ...extra], body }
}

let boundaryCount = 0

export function multipart(subtype: string, parts: readonly Part[], params = ''): Part {
  boundaryCount += 1
  const boundary = `b${boundaryCount}`
  const body = [...parts.flatMap((part) => [`--${boundary}`, ...part.headers, '', part.body]), `--${boundary}--`, ''].join(
    '\r\n'
  )
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"${params}`], body }
}

export const BODY = textPart('text/plain', 'Hallo, anbei die Unterlagen.')

/**
 * A message from the member to the project: `headers` override or add fields
 * (a value of null removes one), `root` is its MIME body.
 */
export function message(root: Part = BODY, headers: Record<string, string | null> = {}): string {
  const head: Record<string, string | null> = {
    From: MEMBER,
    To: PROJECT_ADDRESS,
    Subject: 'Einreichplan',
    Date: SENT_HEADER,
    'Message-ID': '<m1@buero-muster.at>',
    'MIME-Version': '1.0',
    ...headers,
  }
  const lines = Object.entries(head).flatMap(([key, value]) => (value === null ? [] : [`${key}: ${value}`]))
  return [...lines, ...root.headers, '', root.body].join('\r\n')
}

/** A message forwarded as an attachment. */
export const forwarded = (inner: string, extra: string[] = []): Part => ({
  headers: ['Content-Type: message/rfc822', ...extra],
  body: inner,
})

export interface SignSpec {
  domain?: string
  selector?: string
  /** Colon-separated `h=` list. */
  headerList?: string
  /** An `l=` tag. */
  maxBodyLength?: number
  algorithm?: string
  /** An `x=` in the past. */
  expires?: Date
  key?: TestKey
}

/** The message with a DKIM-Signature prepended. */
export async function sign(raw: string, spec: SignSpec = {}): Promise<string> {
  const domain = spec.domain ?? MEMBER_DOMAIN
  const key = spec.key ?? testKey()
  const entry = {
    signingDomain: domain,
    selector: spec.selector ?? 'sel',
    privateKey: key.privatePem,
    ...(spec.maxBodyLength !== undefined ? { maxBodyLength: spec.maxBodyLength } : {}),
    ...(spec.algorithm ? { algorithm: spec.algorithm } : {}),
    ...(spec.headerList ? { headerList: spec.headerList } : {}),
  }
  const options: DKIMSignOptions = {
    signatureData: [entry],
    ...(spec.expires ? { expires: spec.expires, signTime: new Date(spec.expires.getTime() - 60_000) } : {}),
  }
  const { signatures, errors } = await dkimSign(raw, options)
  if (errors.length > 0 || !signatures) throw new Error(`test signing failed: ${JSON.stringify(errors)}`)
  return signatures + raw
}

export const bytes = (raw: string | Uint8Array) => new Uint8Array(typeof raw === 'string' ? Buffer.from(raw) : raw)

// ---------------------------------------------------------------------------
// File bytes
// ---------------------------------------------------------------------------

export const pdf = (tag: string, extra = '') => bytes(`%PDF-1.7\n${tag}\n${extra}\n%%EOF\n`)
export const png = (size: number) => bytes(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 7)]))
export const jpeg = (size: number) => bytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 9)]))
/** A PE executable's first bytes: `MZ`, the DOS stub's offset, and the `PE\0\0` signature at it. */
export function exe(): Uint8Array {
  const image = Buffer.alloc(512, 0)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(0x80, 0x3c)
  image.write('PE\0\0', 0x80, 'latin1')
  return bytes(image)
}
/** A CFB (OLE2) container's header: what a password-protected .docx actually is. */
export function cfb(): Uint8Array {
  const image = Buffer.alloc(1024, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(image)
  return bytes(image)
}
/** A zip local file header; `encrypted` sets general-purpose bit 0. */
export function zipHeader(name = 'a.txt', encrypted = false): Uint8Array {
  const header = Buffer.alloc(30 + name.length + 64, 0)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(encrypted ? 1 : 0, 6)
  header.writeUInt16LE(name.length, 26)
  header.write(name, 30, 'latin1')
  return bytes(header)
}
/**
 * A zip bomb's first bytes: one local header that claims a 4 GiB member,
 * followed by deflate data that would expand without end. Nothing here may
 * inflate it, and the sniff sees only its head.
 */
export function zipBomb(): Uint8Array {
  const header = Buffer.from(zipHeader('bomb.bin'))
  header.writeUInt16LE(8, 8)
  header.writeUInt32LE(0xffffffff, 22)
  return bytes(Buffer.concat([header, Buffer.alloc(512 * 1024, 0)]))
}
/** The EICAR test file, joined at runtime so this source never holds the string. */
export const eicar = () =>
  bytes(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''))

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failing mutation is reproducible from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A copy of `source` with `flips` bytes replaced, inserted or deleted, chosen by `seed`. */
export function mutate(source: Uint8Array, seed: number, flips = 8): Uint8Array {
  const random = seededRandom(seed)
  const out = Array.from(source)
  const interesting = [0x0a, 0x0d, 0x3a, 0x3b, 0x3d, 0x22, 0x2d, 0x00, 0xff, 0x3c, 0x3e, 0x20]
  for (let i = 0; i < flips && out.length > 0; i += 1) {
    const at = Math.floor(random() * out.length)
    const value = random() < 0.5 ? interesting[Math.floor(random() * interesting.length)] : Math.floor(random() * 256)
    const action = random()
    if (action < 0.6) out[at] = value
    else if (action < 0.8) out.splice(at, 0, value)
    else out.splice(at, 1)
  }
  return new Uint8Array(out)
}
