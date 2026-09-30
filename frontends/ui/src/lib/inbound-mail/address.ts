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
import { latinize } from '@/lib/text/latinize'

/** RFC 4648 base32, lowercased: the alphabet a token is drawn from. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // pragma: allowlist secret

/** 12 characters × 5 bits = 60 bits of `crypto.randomBytes`. */
export const TOKEN_LENGTH = 12

const TOKEN_PATTERN = /^[a-z2-7]{12}$/

/** The slug is at most this long, so the local part stays well under 64 octets. */
export const SLUG_MAX_LENGTH = 30

/**
 * A fresh token. 8 random bytes are read and the first 60 bits used; the
 * remaining 4 are discarded rather than biasing the last character.
 */
export function mintToken(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(8)
  let token = ''
  let buffer = 0
  let buffered = 0
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff
    buffered += 8
    while (buffered >= 5 && token.length < TOKEN_LENGTH) {
      buffered -= 5
      token += BASE32_ALPHABET[(buffer >> buffered) & 31]
    }
  }
  return token
}

/**
 * The decoration in front of the token: latinized, `[a-z0-9-]`, at most
 * {@link SLUG_MAX_LENGTH}, never a dot (the parser splits on the last one).
 * A name with nothing Latin in it yields `''`, and the address is then the
 * bare token.
 */
export function projectSlug(projectName: string): string {
  const slug = latinize(projectName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '')
}

/** `<slug>.<token>@<domain>`, or `<token>@<domain>` for an empty slug. */
export function formatInboundAddress(slug: string, token: string, domain: string): string {
  const local = slug ? `${slug}.${token}` : token
  return `${local}@${domain.toLowerCase()}`
}

/**
 * The token an envelope recipient names, or `null` when it names none of ours.
 *
 * `null` covers a foreign domain, a malformed address, and a local part whose
 * last dot-segment is not a well-formed token. All three are answered the same
 * way (404), so nothing here distinguishes them for the caller.
 */
export function parseInboundAddress(recipient: string, domain: string): string | null {
  const trimmed = recipient.trim().replace(/^<|>$/g, '')
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return null
  const recipientDomain = trimmed.slice(at + 1).toLowerCase()
  if (!domain || recipientDomain !== domain.toLowerCase()) return null
  const local = trimmed.slice(0, at).toLowerCase()
  const dot = local.lastIndexOf('.')
  const token = dot === -1 ? local : local.slice(dot + 1)
  return TOKEN_PATTERN.test(token) ? token : null
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
