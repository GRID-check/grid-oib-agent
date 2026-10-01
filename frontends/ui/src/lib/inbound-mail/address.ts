/**
 * Project mail addresses: minting, formatting and parsing (ADR-0074).
 *
 * An address is `<slug>.<token>@<domain>`. Only the TOKEN names a project; the
 * slug is decoration from the project name so a member can tell two addresses
 * apart in their address book. Two organizations can both have a project called
 * `Wohnbau Hietzing`, so resolving by slug would be a cross-tenant lookup keyed
 * on a string anybody can choose. The parser therefore throws the slug away:
 * lowercase the local part, take what follows the LAST dot, and that is the
 * token or nothing.
 *
 * Pure: no database, no environment reads except {@link inboundMailDomain}.
 */

import { randomBytes } from 'node:crypto'
import { slugify } from '@/lib/text/slugify'

/** RFC 4648 base32, lowercased: the alphabet a token is drawn from. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // pragma: allowlist secret

/** 12 characters × 5 bits = 60 bits of `crypto.randomBytes`. */
export const TOKEN_LENGTH = 12

/**
 * What a token looks like. The Email Worker routes on the same shape, so both
 * are held to `tokenPattern` in `shared/inbound-address.json` (address.spec.ts
 * and inbound-mail-worker.spec.ts).
 */
export const TOKEN_PATTERN = /^[a-z2-7]{12}$/

/** The slug is at most this long, so the local part stays well under 64 octets. */
export const SLUG_MAX_LENGTH = 30

/**
 * A fresh token: one random byte per character, its low 5 bits an index into
 * the 32-letter alphabet. 256 is a multiple of 32, so no letter is favoured.
 */
export function mintToken(random: (size: number) => Uint8Array = randomBytes): string {
  return Array.from(random(TOKEN_LENGTH), (byte) => BASE32_ALPHABET[byte & 31]).join('')
}

/**
 * The decoration in front of the token: latinized, `[a-z0-9-]`, at most
 * {@link SLUG_MAX_LENGTH}, never a dot (the parser splits on the last one).
 * A name with nothing Latin in it yields `''`, and the address is then the
 * bare token.
 */
export function projectSlug(projectName: string): string {
  return slugify(projectName, { max: SLUG_MAX_LENGTH })
}

/** `<slug>.<token>@<domain>`, or `<token>@<domain>` for an empty slug. */
export function formatInboundAddress(slug: string, token: string, domain: string): string {
  const local = slug ? `${slug}.${token}` : token
  return `${local}@${domain.toLowerCase()}`
}

/**
 * What an envelope recipient names.
 *
 * - `token`: a local part in our domain that carries a well-formed token.
 * - `malformed`: our domain, but no token in it. Nothing will ever resolve it.
 * - `foreign`: not our domain at all. Cloudflare routes only our domain to the
 *   Worker, so this is a configuration fault on our side, never the sender's.
 */
export type RecipientParse =
  | { kind: 'token'; token: string }
  | { kind: 'malformed' }
  | { kind: 'foreign' }

/** ASCII-only lowercasing: `İ` and `K` (Kelvin) must not fold onto `i` and `k`. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * The local part without the decoration a sender's client may add: the
 * surrounding quotes of a quoted local part, and a `+detail` subaddress
 * (`wohnbau.abcdefgh2345+plaene`), which is dropped before the last-dot split.
 */
function bareLocalPart(local: string): string {
  const unquoted = local.length >= 2 && local.startsWith('"') && local.endsWith('"') ? local.slice(1, -1) : local
  const plus = unquoted.indexOf('+')
  return plus === -1 ? unquoted : unquoted.slice(0, plus)
}

/** Parse an envelope recipient against the deployment's inbound domain. */
export function parseInboundAddress(recipient: string, domain: string): RecipientParse {
  const trimmed = recipient.trim().replace(/^<|>$/g, '')
  const at = trimmed.lastIndexOf('@')
  const recipientDomain = at === -1 ? '' : asciiLower(trimmed.slice(at + 1))
  if (!domain || recipientDomain !== asciiLower(domain)) return { kind: 'foreign' }
  const local = asciiLower(bareLocalPart(trimmed.slice(0, at)))
  const dot = local.lastIndexOf('.')
  const token = dot === -1 ? local : local.slice(dot + 1)
  return TOKEN_PATTERN.test(token) ? { kind: 'token', token } : { kind: 'malformed' }
}

/** Whether a string is a well-formed token (the database CHECK, restated). */
export function isToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

/**
 * The deployment's inbound mail domain, or `null` when the feature is off.
 * `GRID_INBOUND_MAIL_DOMAIN`, e.g. `piloti-post.at`.
 */
export function inboundMailDomain(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const domain = env.GRID_INBOUND_MAIL_DOMAIN?.trim().toLowerCase()
  return domain ? domain : null
}
