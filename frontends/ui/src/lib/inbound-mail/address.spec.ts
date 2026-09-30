/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  formatInboundAddress,
  inboundMailDomain,
  isToken,
  mintToken,
  parseInboundAddress,
  projectSlug,
} from './address'

const DOMAIN = 'piloti-post.at'

describe('parseInboundAddress', () => {
  it('takes the token after the slug', () => {
    expect(parseInboundAddress(`wohnbau-hietzing.abcdefgh2345@${DOMAIN}`, DOMAIN)).toBe('abcdefgh2345')
  })

  it('accepts a bare token (empty slug)', () => {
    expect(parseInboundAddress(`abcdefgh2345@${DOMAIN}`, DOMAIN)).toBe('abcdefgh2345')
  })

  it('lowercases the local part and the domain', () => {
    expect(parseInboundAddress(`Wohnbau.ABCDEFGH2345@Piloti-Post.AT`, DOMAIN)).toBe('abcdefgh2345')
  })

  it('takes the segment after the LAST dot, whatever sits in the slug position', () => {
    // A slug never contains a dot, but a hand-typed address may; only the
    // token resolves, so the rest is ignored rather than refused.
    expect(parseInboundAddress(`a.b.wohnbau.abcdefgh2345@${DOMAIN}`, DOMAIN)).toBe('abcdefgh2345')
    // …and a slug that happens to LOOK like a token is not the token.
    expect(parseInboundAddress(`zzzzzzzzzzzz.abcdefgh2345@${DOMAIN}`, DOMAIN)).toBe('abcdefgh2345')
  })

  it('refuses a foreign domain, including a lookalike subdomain', () => {
    expect(parseInboundAddress('wohnbau.abcdefgh2345@example.com', DOMAIN)).toBeNull()
    expect(parseInboundAddress(`wohnbau.abcdefgh2345@evil.${DOMAIN}`, DOMAIN)).toBeNull()
    expect(parseInboundAddress(`wohnbau.abcdefgh2345@${DOMAIN}.evil.com`, DOMAIN)).toBeNull()
  })

  it('refuses garbage', () => {
    for (const recipient of [
      '',
      'no-at-sign',
      `@${DOMAIN}`,
      `wohnbau.@${DOMAIN}`,
      `wohnbau.abcdefgh234@${DOMAIN}`, // 11 characters
      `wohnbau.abcdefgh23456@${DOMAIN}`, // 13 characters
      `wohnbau.abcdefgh2301@${DOMAIN}`, // 0 and 1 are not base32
      `wohnbau.abcdefgh234!@${DOMAIN}`,
      `wohnbau+tag.abcdefgh2345+x@${DOMAIN}`,
    ]) {
      expect(parseInboundAddress(recipient, DOMAIN), recipient).toBeNull()
    }
  })

  it('refuses everything when no domain is configured', () => {
    expect(parseInboundAddress(`abcdefgh2345@${DOMAIN}`, '')).toBeNull()
  })

  it('tolerates angle brackets and whitespace around the recipient', () => {
    expect(parseInboundAddress(` <abcdefgh2345@${DOMAIN}> `, DOMAIN)).toBe('abcdefgh2345')
  })
})

describe('mintToken', () => {
  it('is 12 characters of lowercase base32', () => {
    for (let i = 0; i < 200; i += 1) expect(isToken(mintToken())).toBe(true)
  })

  it('reads the first 60 bits of the random bytes', () => {
    expect(mintToken(() => Buffer.alloc(8, 0))).toBe('aaaaaaaaaaaa')
    expect(mintToken(() => Buffer.alloc(8, 0xff))).toBe('777777777777')
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => mintToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('projectSlug', () => {
  it('latinizes and hyphenates the project name', () => {
    expect(projectSlug('Wohnbau Hietzing')).toBe('wohnbau-hietzing')
    expect(projectSlug('Straßenbau Süd / Los 2')).toBe('strassenbau-sued-los-2')
  })

  it('never contains a dot, and is at most 30 characters without a trailing hyphen', () => {
    const slug = projectSlug('Sanierung Schule Am.Park.Weg Bauteil A und B und C')
    expect(slug).not.toContain('.')
    expect(slug.length).toBeLessThanOrEqual(30)
    expect(slug).toMatch(/^[a-z0-9-]*[a-z0-9]$/)
  })

  it('is empty for a name with nothing Latin in it', () => {
    expect(projectSlug('東京プロジェクト')).toBe('')
  })
})

describe('formatInboundAddress', () => {
  it('joins slug and token, or uses the token alone', () => {
    expect(formatInboundAddress('wohnbau', 'abcdefgh2345', 'Piloti-Post.at')).toBe(
      'wohnbau.abcdefgh2345@piloti-post.at'
    )
    expect(formatInboundAddress('', 'abcdefgh2345', DOMAIN)).toBe(`abcdefgh2345@${DOMAIN}`)
  })

  it('round-trips through the parser', () => {
    const token = mintToken()
    const address = formatInboundAddress(projectSlug('Wohnbau Hietzing'), token, DOMAIN)
    expect(parseInboundAddress(address, DOMAIN)).toBe(token)
  })
})

describe('inboundMailDomain', () => {
  it('is null when unset or blank, and lowercased otherwise', () => {
    expect(inboundMailDomain({})).toBeNull()
    expect(inboundMailDomain({ GRID_INBOUND_MAIL_DOMAIN: '  ' })).toBeNull()
    expect(inboundMailDomain({ GRID_INBOUND_MAIL_DOMAIN: 'Piloti-Post.AT' })).toBe(DOMAIN)
  })
})
