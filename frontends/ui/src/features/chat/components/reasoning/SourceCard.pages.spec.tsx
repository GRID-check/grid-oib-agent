/**
 * The Herleitung card names the pages it READ, not only the ones cited.
 *
 * Two claims share one line of markup and they are not the same claim. Under
 * the answer, „S. 5" / "pp. 5" asserts the answer leaned on page 5, so those chips may
 * only count cited loci. This card also stands for a document the answer did
 * NOT use — it says so, in words, right beside the pages — and every locus of
 * such a document is `isCited: false`. Counting only cited loci there deletes
 * the line entirely and the card silently stops saying what retrieval read.
 */

import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { SourceCard } from './SourceCard'
import type { CitedDocument } from '../../lib/citations'

const document = (loci: CitedDocument['loci']): CitedDocument => ({
  id: 'doc:base:oib-2',
  title: 'OIB-Richtlinie 2',
  fileName: 'OIB-Richtlinie-2.pdf',
  collection: 'base',
  kind: 'baurecht',
  tint: 'law',
  loci,
})

const renderCard = (loci: CitedDocument['loci']) =>
  render(<SourceCard document={document(loci)} hitLabel="2 Treffer" gapLabel="0 Treffer" />)

describe('SourceCard — pages', () => {
  test('a retrieved-but-uncited document still names the pages it was read at', () => {
    renderCard([
      { key: 'p:4', page: 4, isCited: false },
      { key: 'p:9', page: 9, isCited: false },
    ])

    expect(screen.getByText('retrieved, not cited')).toBeInTheDocument()
    expect(screen.getByText('pp. 4, 9')).toBeInTheDocument()
  })

  test('a cited document names only the pages the answer used', () => {
    // Retrieval read three pages; the answer cited one. The card is about the
    // derivation, but once a document IS cited the honest number is the cited
    // one — the same claim the chip under the answer makes.
    renderCard([
      { key: 'p:4', page: 4, isCited: false },
      { key: 'p:9', page: 9, isCited: true, number: 1 },
      { key: 'p:12', page: 12, isCited: false },
    ])

    expect(screen.getByText('p. 9')).toBeInTheDocument()
    expect(screen.queryByText('retrieved, not cited')).not.toBeInTheDocument()
  })
})
