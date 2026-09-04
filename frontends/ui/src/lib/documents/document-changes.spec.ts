/**
 * The signal that keeps a page-lifetime document cache from going stale.
 *
 * Two module-scope caches hold document listings for the whole page —
 * `useSourcePreviewIndex` and `useSurfacedDocuments` — and neither was ever
 * invalidated outside tests. So a file uploaded DURING a conversation was
 * invisible to both: the answer cited it, and the chip offered no way in and no
 * reason, until a reload. That is the #623 complaint on a path its fix did not
 * reach, which is why the invalidation is a signal every mutation fires rather
 * than something each cache's owner has to be told about.
 */

import { describe, expect, it, vi } from 'vitest'
import { notifyDocumentsChanged, onDocumentsChanged } from './document-changes'

describe('document change notifications', () => {
  it('tells every listener', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = onDocumentsChanged(first)
    const offSecond = onDocumentsChanged(second)

    notifyDocumentsChanged()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offFirst()
    offSecond()
  })

  it('stops telling one that unsubscribed', () => {
    const listener = vi.fn()
    onDocumentsChanged(listener)()

    notifyDocumentsChanged()

    expect(listener).not.toHaveBeenCalled()
  })

  it('a listener that unsubscribes itself does not make the next one miss out', () => {
    // Iterating the live set would skip an entry when the one before it removes
    // itself — and the entry skipped is a cache that then serves stale rows.
    const calls: string[] = []
    const off = onDocumentsChanged(() => {
      calls.push('first')
      off()
    })
    const offSecond = onDocumentsChanged(() => calls.push('second'))

    notifyDocumentsChanged()

    expect(calls).toEqual(['first', 'second'])
    offSecond()
  })

  it('one throwing listener does not stop the rest being told', () => {
    // Otherwise an unrelated bug in one cache becomes a stale citation index in
    // another, which reads to the user as a document the product has lost.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const after = vi.fn()
    const offBad = onDocumentsChanged(() => {
      throw new Error('boom')
    })
    const offAfter = onDocumentsChanged(after)

    notifyDocumentsChanged()

    expect(after).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    offBad()
    offAfter()
    warn.mockRestore()
  })
})
