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

const token = (value: string) => ({ kind: 'token', token: value })

describe('parseInboundAddress', () => {
  it('takes the token after the slug', () => {
    expect(parseInboundAddress(`wohnbau-hietzing.abcdefgh2345@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
  })

  it('accepts a bare token (empty slug)', () => {
    expect(parseInboundAddress(`abcdefgh2345@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
  })

  it('lowercases the local part and the domain', () => {
    expect(parseInboundAddress(`Wohnbau.ABCDEFGH2345@Piloti-Post.AT`, DOMAIN)).toEqual(token('abcdefgh2345'))
  })

  it('lowercases ASCII only: a Kelvin sign or dotted capital I is not a letter of the token', () => {
    expect(parseInboundAddress(`wohnbau.abcdefgh234\u212a@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'malformed' })
    expect(parseInboundAddress(`wohnbau.\u0130bcdefgh2345@${DOMAIN}`, DOMAIN)).toEqual({ kind: 'malformed' })
  })

  it('takes the segment after the LAST dot, whatever sits in the slug position', () => {
    // A slug never contains a dot, but a hand-typed address may; only the
    // token resolves, so the rest is ignored rather than refused.
    expect(parseInboundAddress(`a.b.wohnbau.abcdefgh2345@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
    // …and a slug that happens to LOOK like a token is not the token.
    expect(parseInboundAddress(`zzzzzzzzzzzz.abcdefgh2345@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
  })

  it('drops a +detail subaddress and the quotes of a quoted local part before the split', () => {
    expect(parseInboundAddress(`wohnbau.abcdefgh2345+plaene@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
    expect(parseInboundAddress(`wohnbau.abcdefgh2345+a.b@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
    expect(parseInboundAddress(`"wohnbau.abcdefgh2345"@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
    expect(parseInboundAddress(`"wohnbau.abcdefgh2345+x"@${DOMAIN}`, DOMAIN)).toEqual(token('abcdefgh2345'))
  })

  it('calls a foreign domain foreign, including a lookalike subdomain', () => {
    expect(parseInboundAddress('wohnbau.abcdefgh2345@example.com', DOMAIN)).toEqual({ kind: 'foreign' })
    expect(parseInboundAddress(`wohnbau.abcdefgh2345@evil.${DOMAIN}`, DOMAIN)).toEqual({ kind: 'foreign' })
    expect(parseInboundAddress(`wohnbau.abcdefgh2345@${DOMAIN}.evil.com`, DOMAIN)).toEqual({ kind: 'foreign' })
    expect(parseInboundAddress('no-at-sign', DOMAIN)).toEqual({ kind: 'foreign' })
    expect(parseInboundAddress('', DOMAIN)).toEqual({ kind: 'foreign' })
  })

  it('calls an address in our domain without a well-formed token malformed', () => {
    for (const recipient of [
      `@${DOMAIN}`,
      `wohnbau.@${DOMAIN}`,
      `wohnbau.abcdefgh234@${DOMAIN}`, // 11 characters
      `wohnbau.abcdefgh23456@${DOMAIN}`, // 13 characters
      `wohnbau.abcdefgh2301@${DOMAIN}`, // 0 and 1 are not base32
      `wohnbau.abcdefgh234!@${DOMAIN}`,
      `+abcdefgh2345@${DOMAIN}`,
    ]) {
      expect(parseInboundAddress(recipient, DOMAIN), recipient).toEqual({ kind: 'malformed' })
    }
  })

  it('calls everything foreign when no domain is configured', () => {
    expect(parseInboundAddress(`abcdefgh2345@${DOMAIN}`, '')).toEqual({ kind: 'foreign' })
  })

  it('tolerates angle brackets and whitespace around the recipient', () => {
    expect(parseInboundAddress(` <abcdefgh2345@${DOMAIN}> `, DOMAIN)).toEqual(token('abcdefgh2345'))
  })
})

describe('mintToken', () => {
  it('is 12 characters of lowercase base32', () => {
    for (let i = 0; i < 200; i += 1) expect(isToken(mintToken())).toBe(true)
  })

  it('maps each random byte to one letter by its low five bits', () => {
    expect(mintToken(() => Buffer.alloc(12, 0))).toBe('aaaaaaaaaaaa')
    expect(mintToken(() => Buffer.alloc(12, 0xff))).toBe('777777777777')
    expect(mintToken(() => Buffer.from([0, 1, 25, 26, 31, 32, 33, 63, 64, 224, 255, 7]))).toBe('abz27ab7aa7h')
  })

  it('reads exactly twelve bytes', () => {
    const sizes: number[] = []
    mintToken((size) => {
      sizes.push(size)
      return Buffer.alloc(size)
    })
    expect(sizes).toEqual([12])
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
    const minted = mintToken()
    const address = formatInboundAddress(projectSlug('Wohnbau Hietzing'), minted, DOMAIN)
    expect(parseInboundAddress(address, DOMAIN)).toEqual(token(minted))
  })
})

describe('inboundMailDomain', () => {
  it('is null when unset or blank, and lowercased otherwise', () => {
    expect(inboundMailDomain({})).toBeNull()
    expect(inboundMailDomain({ GRID_INBOUND_MAIL_DOMAIN: '  ' })).toBeNull()
    expect(inboundMailDomain({ GRID_INBOUND_MAIL_DOMAIN: 'Piloti-Post.AT' })).toBe(DOMAIN)
  })
})
