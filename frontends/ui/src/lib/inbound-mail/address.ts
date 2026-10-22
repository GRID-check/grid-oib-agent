/**
 * A project's mail address: minting, formatting, parsing and redacting it
 * (ADR-0135).
 *
 * An address is `<slug>.<token>@<domain>`. Only the TOKEN names a project; the
 * slug is decoration from the project name, so a person can tell two addresses
 * apart in an address book. Two offices can both have a project called
 * `Wohnbau Hietzing`, so resolving by slug would be a cross-tenant lookup keyed
 * on a string anybody can choose. The parser therefore throws the slug away:
 * lowercase the local part, take what follows the LAST dot, and that is the
 * token or nothing.
 *
 * The Email Worker routes on the same shape without asking the BFF, so both
 * sides run the cases of `shared/inbound-address.json` (`address.spec.ts`,
 * `inbound-mail-worker.spec.ts`), and neither can change the rule alone.
 *
 * Pure: no database, and no environment read except {@link inboundMailDomain}.
 */

import { randomBytes } from 'node:crypto'
import { fileSlug } from '@/lib/text/latinize'

/** RFC 4648 base32, lowercased: the alphabet a token is drawn from. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // pragma: allowlist secret

/** 12 characters × 5 bits = 60 bits of `crypto.randomBytes`. */
export const TOKEN_LENGTH = 12

/** What a token looks like; `tokenPattern` in `shared/inbound-address.json`. */
export const TOKEN_PATTERN = /^[a-z2-7]{12}$/

/** The slug is at most this long, so the local part stays well under 64 octets. */
export const SLUG_MAX_LENGTH = 30

/**
 * What stands in for a token that is redacted. Not base32 and not an address
 * character, so a redacted address can never resolve or be mistaken for one.
 */
export const REDACTED_TOKEN = '…'

/**
 * A fresh token: one random byte per character, its low 5 bits an index into
 * the 32-letter alphabet. 256 is a multiple of 32, so no letter is favoured.
 */
export function mintToken(random: (size: number) => Uint8Array = randomBytes): string {
  return Array.from(random(TOKEN_LENGTH), (byte) => BASE32_ALPHABET[byte & 31]).join('')
}

/**
 * The decoration in front of the token: {@link fileSlug} of the project name
 * (latinized, `[a-z0-9-]`, no hyphen at either end), at most
 * {@link SLUG_MAX_LENGTH}. It never holds a dot, which the parser splits on.
 * A name with nothing Latin in it yields `''`, and the address is then the
 * bare token.
 */
export function projectSlug(projectName: string): string {
  return fileSlug(projectName, { maxLength: SLUG_MAX_LENGTH })
}

/** `<slug>.<token>@<domain>`, or `<token>@<domain>` for an empty slug. */
export function formatInboundAddress(slug: string, token: string, domain: string): string {
  const local = slug ? `${slug}.${token}` : token
  return `${local}@${asciiLower(domain)}`
}

/**
 * What an envelope recipient names.
 *
 * - `token`: a local part in our domain that carries a well-formed token.
 * - `malformed`: our domain, but no token in it. Nothing will ever resolve it.
 * - `foreign`: not our domain at all. Cloudflare routes only our domain to the
 *   Worker, so for an envelope recipient this is a configuration fault on our
 *   side, never the sender's.
 */
export type RecipientParse = { kind: 'token'; token: string } | { kind: 'malformed' } | { kind: 'foreign' }

/** ASCII-only lowercasing: `İ` and `K` (the Kelvin sign) must not fold onto `i` and `k`. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * The local part without what a sender's client may add around it: the quotes
 * of a quoted local part, and a `+detail` subaddress
 * (`wohnbau.abcdefgh2345+plaene`), dropped before the last-dot split.
 */
function bareLocalPart(local: string): string {
  const unquoted = local.length >= 2 && local.startsWith('"') && local.endsWith('"') ? local.slice(1, -1) : local
  const plus = unquoted.indexOf('+')
  return plus === -1 ? unquoted : unquoted.slice(0, plus)
}

/** The token a local part carries, or null. */
function tokenOfLocalPart(local: string): string | null {
  const bare = asciiLower(bareLocalPart(local))
  const token = bare.slice(bare.lastIndexOf('.') + 1)
  return TOKEN_PATTERN.test(token) ? token : null
}

/** Parse an envelope recipient, or any header address, against the deployment's inbound domain. */
export function parseInboundAddress(recipient: string, domain: string): RecipientParse {
  const trimmed = recipient.trim().replace(/^<|>$/g, '')
  const at = trimmed.lastIndexOf('@')
  const recipientDomain = at === -1 ? '' : asciiLower(trimmed.slice(at + 1))
  if (!domain || recipientDomain !== asciiLower(domain)) return { kind: 'foreign' }
  const token = tokenOfLocalPart(trimmed.slice(0, at))
  return token ? { kind: 'token', token } : { kind: 'malformed' }
}

/**
 * The deployment's inbound mail domain (`GRID_INBOUND_MAIL_DOMAIN`, e.g.
 * `piloti.at`), or null when the deployment receives no mail. That is the
 * deployment's half of the switch; the office's half is the `inbound-mail`
 * WorkOS flag.
 */
export function inboundMailDomain(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const domain = env.GRID_INBOUND_MAIL_DOMAIN?.trim()
  return domain ? asciiLower(domain) : null
}

/**
 * A local part, `@` and a host: the candidates {@link redactProjectAddresses}
 * compares with the configured domain. A literal pattern, so no configured
 * value is ever compiled into a regex; both bounds keep the scan linear.
 */
const ADDRESS_CANDIDATE = /("[^"\s@]{1,64}"|[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([A-Za-z0-9.-]{1,255})/g

/** A host character: the domain matches only when none follows it. */
const HOST_CHARACTER = /[A-Za-z0-9-]/

/**
 * Every project address in `text` with its token replaced by
 * {@link REDACTED_TOKEN}, except the token `keep` (ADR-0134, check B8).
 *
 * A mail to one project may quote, forward or Cc another project's address,
 * and that address belongs to another office. The receive job runs this over
 * the subject, the participants and the text before anything is staged for a
 * person to read; a filed entry redacts the receiving token too (`keep`
 * omitted). The slug stays, so a reader still sees which kind of address it
 * was. The original `.eml` is never redacted: it is evidence, and gated.
 *
 * The local part is bounded at 64 characters (RFC 5321 §4.5.3.1.1), which also
 * keeps the scan linear: an unbounded `[^@]+@` restarts at every position of a
 * long run without an `@` and turns a 5 MB body quadratic.
 */
export function redactProjectAddresses(text: string, domain: string, keep: string | null = null): string {
  if (!domain || !text.includes('@')) return text
  const lowerDomain = asciiLower(domain)
  return text.replace(ADDRESS_CANDIDATE, (whole: string, local: string, host: string) => {
    const lowerHost = asciiLower(host)
    if (!lowerHost.startsWith(lowerDomain) || HOST_CHARACTER.test(lowerHost.charAt(lowerDomain.length))) return whole
    const token = tokenOfLocalPart(local)
    if (!token || token === keep) return whole
    const bare = bareLocalPart(local)
    const slug = bare.slice(0, bare.lastIndexOf('.') + 1)
    return `${slug}${REDACTED_TOKEN}@${lowerDomain}${host.slice(lowerDomain.length)}`
  })
}
