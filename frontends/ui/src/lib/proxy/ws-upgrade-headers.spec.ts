/**
 * @vitest-environment node
 */
/**
 * The WebSocket proxy strips what only it may set (`server.js`).
 *
 * Each context header was written only when the scope response had the field,
 * so a client's own `x-grid-model-overrides`, `x-grid-budget` or
 * `x-grid-disabled-sources` reached the backend whenever the scope left that
 * field empty. These cases pin the strip itself and that `server.js` runs it
 * before it writes a single context header.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripClientContextHeaders } from './ws-upgrade-headers.js'

describe('stripClientContextHeaders', () => {
  it('removes every x-grid-* header a client sent', () => {
    const headers: Record<string, string> = {
      'x-grid-model-overrides': 'eyJkZWVwX3Jlc2VhcmNoIjoieC9ncm9rIn0',
      'x-grid-budget': 'eyJyZW1haW5pbmdPcmdVc2QiOjk5OTk5fQ',
      'x-grid-disabled-sources': 'W10',
      'x-grid-request-context': 'forged',
      'x-grid-request-context-sig': 'forged',
      'x-grid-internal-token': 'guess',
      'x-grid-some-future-field': 'x',
    }

    const removed = stripClientContextHeaders(headers)

    expect(headers).toEqual({})
    expect(removed).toHaveLength(7)
  })

  it('removes a client bearer and the service-token header', () => {
    const headers: Record<string, string> = {
      authorization: 'Bearer someone-elses-token',
      'x-internal-token': 'guess',
    }

    stripClientContextHeaders(headers)

    expect(headers).toEqual({})
  })

  it('keeps what the proxy and the backend need from the client', () => {
    const headers: Record<string, string> = {
      cookie: 'wos-session=abc',
      host: 'app.example',
      origin: 'https://app.example',
      'sec-websocket-key': 'k',
      'sec-websocket-version': '13',
      'x-forwarded-for': '203.0.113.7',
      // Not the prefix: a header that merely contains the letters survives.
      'x-gridlock': 'y',
    }
    const before = { ...headers }

    expect(stripClientContextHeaders(headers)).toEqual([])
    expect(headers).toEqual(before)
  })
})

describe('server.js strips before it writes', () => {
  const source = readFileSync(new URL('../../../server.js', import.meta.url), 'utf8')

  it('requires the strip', () => {
    expect(source).toMatch(/require\('\.\/src\/lib\/proxy\/ws-upgrade-headers\.js'\)/)
  })

  it('runs it on the upgrade before the first context header is set', () => {
    const strip = source.indexOf('stripClientContextHeaders(req.headers)')
    const firstWrite = source.indexOf("req.headers['x-grid-")
    expect(strip, 'the upgrade handler no longer strips client headers').toBeGreaterThan(-1)
    expect(firstWrite).toBeGreaterThan(-1)
    expect(strip).toBeLessThan(firstWrite)
  })
})
