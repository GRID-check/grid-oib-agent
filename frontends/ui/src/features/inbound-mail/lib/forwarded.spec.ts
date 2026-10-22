/**
 * Who a forwarded mail originally came from, read from the forwarded text
 * the way German and English mail programs write it. Never for a reply.
 */

import { describe, expect, it } from 'vitest'
import { forwardedOrigin, parseAddressLine } from './forwarded'

const quoted = (header: string, text = '') => ({ quoted: [{ header, text }] })

describe('forwardedOrigin', () => {
  it('reads Outlook’s German block from the quoted text', () => {
    const origin = forwardedOrigin(
      'WG: Verhandlungsschrift',
      quoted('-----Ursprüngliche Nachricht-----', 'Von: MA 37 – Baupolizei <post@ma37.wien.gv.at>\nGesendet: Montag\nAn: Huber'),
    )
    expect(origin).toEqual({ name: 'MA 37 – Baupolizei', address: 'post@ma37.wien.gv.at' })
  })

  it('reads Apple Mail’s and Gmail’s English header line', () => {
    expect(forwardedOrigin('Fwd: Plan', quoted('Begin forwarded message:\nFrom: "Weber, Petra" <P.Weber@Statik-Weber.at>'))).toEqual({
      name: 'Weber, Petra',
      address: 'p.weber@statik-weber.at',
    })
    expect(forwardedOrigin('Fwd: x', quoted('From: *Karl Bauer* <k@bauer.at>'))?.address).toBe('k@bauer.at')
  })

  it('is null for a reply, a mail without a quote, or a quote without a sender line', () => {
    expect(forwardedOrigin('AW: Plan', quoted('Von: A <a@b.at>'))).toBeNull()
    expect(forwardedOrigin('WG: Plan', { quoted: [] })).toBeNull()
    expect(forwardedOrigin('WG: Plan', quoted('Am Montag schrieb jemand:', 'Hallo'))).toBeNull()
    expect(forwardedOrigin('WG: Plan', null)).toBeNull()
  })
})

describe('parseAddressLine', () => {
  it.each([
    ['Name <a@b.at>', { name: 'Name', address: 'a@b.at' }],
    ['"Name" <A@B.AT>', { name: 'Name', address: 'a@b.at' }],
    ['Name [mailto:a@b.at]', { name: 'Name', address: 'a@b.at' }],
    ['a@b.at', { name: null, address: 'a@b.at' }],
    ['<a@b.at>', { name: null, address: 'a@b.at' }],
    ['MA 37', { name: 'MA 37', address: null }],
  ])('%s', (value, expected) => {
    expect(parseAddressLine(value)).toEqual(expected)
  })

  it('is null for nothing', () => {
    expect(parseAddressLine('   ')).toBeNull()
  })
})
