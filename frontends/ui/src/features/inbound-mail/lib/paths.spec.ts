/** Where the E-Mail-Eingang lives, with the filter on the URL. */

import { describe, expect, it } from 'vitest'
import { inboundMailPaths } from './paths'

describe('inboundMailPaths', () => {
  const paths = inboundMailPaths('p 1')

  it('leaves the default filter off the URL', () => {
    expect(paths.list({ status: 'waiting', outcome: null })).toBe('/app/projects/p%201/files/mail')
    expect(paths.mail('m1', { status: 'waiting', outcome: 'filed' })).toBe('/app/projects/p%201/files/mail/m1')
  })

  it('carries the handled list and its facet', () => {
    expect(paths.list({ status: 'handled', outcome: 'dismissed' })).toBe('/app/projects/p%201/files/mail?status=handled&outcome=dismissed')
    expect(paths.mail('m1', { status: 'handled', outcome: null })).toBe('/app/projects/p%201/files/mail/m1?status=handled')
    expect(paths.files).toBe('/app/projects/p%201/files')
  })
})
