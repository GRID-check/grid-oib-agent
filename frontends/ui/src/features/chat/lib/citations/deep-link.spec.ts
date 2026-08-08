/**
 * A citation link is an address, so it has to survive being pasted.
 */

import { describe, expect, it } from 'vitest'
import {
  citationShareUrl,
  encodeCitationLink,
  parseCitationLink,
  resolveCitationLink,
} from './deep-link'
import { buildCitationModel } from './build'
import type { CitationSource } from '../../types'

const at = new Date(0)
const FILE = 'oib-rl_2.1_ausgabe_mai_2023.pdf'

const locus = (page: number, number: number): CitationSource => ({
  id: `c${number}`,
  content: `[KB] ${FILE}, p.${page}`,
  citationKey: `${FILE}, p.${page}`,
  fileName: FILE,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2.1, Ausgabe Mai 2023',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  origin: 'kb',
  timestamp: at,
  page,
  number,
  isCited: true,
})

const documents = buildCitationModel({ citations: [locus(5, 1), locus(18, 2)] })
const document = documents[0]!

describe('citation deep links', () => {
  it('round-trips a reference to one passage', () => {
    const ref = { document, locus: document.loci[1]! }
    const restored = resolveCitationLink(parseCitationLink(encodeCitationLink(ref)), documents)

    expect(restored?.document.id).toBe(document.id)
    expect(restored?.locus?.page).toBe(18)
  })

  it('round-trips a reference to the document as a whole', () => {
    const restored = resolveCitationLink(parseCitationLink(encodeCitationLink({ document })), documents)
    expect(restored?.document.id).toBe(document.id)
    expect(restored?.locus).toBeUndefined()
  })

  it('survives the separator appearing inside a document id', () => {
    // A filename may legitimately contain the separator character; encoding
    // each half independently is what keeps the split unambiguous.
    const odd = buildCitationModel({
      citations: [{ ...locus(3, 1), fileName: 'Plan~Rev~2.pdf', citationKey: 'Plan~Rev~2.pdf, p.3' }],
    })
    const ref = { document: odd[0]!, locus: odd[0]!.loci[0]! }
    const restored = resolveCitationLink(parseCitationLink(encodeCitationLink(ref)), odd)

    expect(restored?.document.id).toBe(odd[0]!.id)
    expect(restored?.locus?.page).toBe(3)
  })

  it('survives a comma in the document id read straight off a URL', () => {
    // The value goes through ONE decode on the way in (`searchParams.get`), so
    // a document whose name carries the separator is exactly the case a
    // percent-encoded link loses: the decode hands the parser a second comma.
    const comma = buildCitationModel({
      citations: [{ ...locus(3, 1), fileName: 'Plan,Rev.pdf', citationKey: 'Plan,Rev.pdf, p.3' }],
    })
    const ref = { document: comma[0]!, locus: comma[0]!.loci[0]! }
    const url = new URL(`https://app.example/app/chat?cite=${encodeCitationLink(ref)}`)
    const restored = resolveCitationLink(parseCitationLink(url.searchParams.get('cite')), comma)

    expect(comma[0]!.id).toContain(',')
    expect(restored?.document.id).toBe(comma[0]!.id)
    expect(restored?.locus?.page).toBe(3)
  })

  it('opens the document when the linked passage no longer exists', () => {
    // Re-retrieval can land on different pages than when the link was shared.
    // Losing the page is a graceful outcome; losing the document is not.
    const stale = parseCitationLink(
      encodeCitationLink({ document, locus: { ...document.loci[0]!, key: 'p:999' } })
    )
    const restored = resolveCitationLink(stale, documents)

    expect(restored?.document.id).toBe(document.id)
    expect(restored?.locus).toBeUndefined()
  })

  it('an answer that does not hold the linked document resolves to nothing', () => {
    // Every answer on screen sees the same parameter; only the one holding the
    // document may act on it.
    const other = buildCitationModel({
      citations: [{ ...locus(1, 1), fileName: 'Andere.pdf', citationKey: 'Andere.pdf, p.1' }],
    })
    expect(resolveCitationLink(parseCitationLink(encodeCitationLink({ document })), other)).toBeNull()
  })

  it('a mangled link degrades to nothing rather than throwing', () => {
    // Not base64url at all (a hand-edited or truncated link).
    expect(parseCitationLink('doc:oib_knowledge:file.pdf,p:3')).toBeNull()
    expect(parseCitationLink('%E0%A4%A')).toBeNull()
    expect(parseCitationLink('')).toBeNull()
    expect(parseCitationLink(null)).toBeNull()
    expect(resolveCitationLink(null, documents)).toBeNull()
  })

  it('builds a shareable URL that keeps the page it was shared from', () => {
    const url = citationShareUrl(
      { document, locus: document.loci[1]! },
      { origin: 'https://app.example', pathname: '/app/chat', search: '?project=abc' }
    )
    const parsed = new URL(url)

    expect(parsed.searchParams.get('project')).toBe('abc')
    expect(resolveCitationLink(parseCitationLink(parsed.searchParams.get('cite')), documents)?.locus?.page).toBe(18)
  })
})
