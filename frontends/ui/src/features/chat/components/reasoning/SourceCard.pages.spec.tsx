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
import { BareSourceCard, SourceCard } from './SourceCard'
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

/**
 * Under a round the ledger accounts for, the card speaks for THAT round.
 *
 * The turn aggregate — "2 Treffer", the cited page — is identical on every
 * repeat of the same file, which is what made a round that re-opened four
 * files at new pages indistinguishable from a second fetch of them.
 */
describe('SourceCard — a ledger round speaks for its own slot', () => {
  const loci: CitedDocument['loci'] = [
    { key: 'p:4', page: 4, isCited: true, number: 1 },
    { key: 'p:9', page: 9, isCited: true, number: 2 },
  ]

  test('the locus line is the round’s own, and a re-read says so instead of counting', () => {
    render(
      <SourceCard
        document={document(loci)}
        hitLabel="2 hits"
        gapLabel="Nothing found"
        round={{ detail: 'p. 12', repeat: true }}
      />
    )

    expect(screen.getByText('p. 12')).toBeInTheDocument()
    expect(screen.getByText('already retrieved')).toBeInTheDocument()
    // Neither the turn's tally nor its cited pages: both are claims about the
    // whole turn, and this slot is a claim about one round.
    expect(screen.queryByText('2 hits')).not.toBeInTheDocument()
    expect(screen.queryByText('pp. 4, 9')).not.toBeInTheDocument()
  })

  test('a round showing a file for the first time keeps the count, and names no locus it did not read', () => {
    render(
      <SourceCard
        document={document(loci)}
        hitLabel="2 hits"
        gapLabel="Nothing found"
        round={{ repeat: false }}
      />
    )

    expect(screen.getByText('2 hits')).toBeInTheDocument()
    expect(screen.queryByText('already retrieved')).not.toBeInTheDocument()
    // The round named no page, so the card names none — borrowing the turn's
    // would attribute another round's passage to this one.
    expect(screen.queryByText('pp. 4, 9')).not.toBeInTheDocument()
  })

  test('a ledger doc with no card is a name and a locus, and nothing that claims more', () => {
    render(<BareSourceCard name="Reparatur.pdf" detail="p. 1" />)

    expect(screen.getByText('Reparatur.pdf')).toBeInTheDocument()
    expect(screen.getByText('p. 1')).toBeInTheDocument()
    // No preview chip, no markers: there is no card behind this name, so every
    // control would open nothing.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
