/**
 * The Herleitung source card states the shelf it was GIVEN (ADR-0047).
 *
 * `shelf.spec.ts` pins the model; this pins what a reader actually sees on the
 * card's folder tab — the surface where the defect was visible: a file the user
 * attached privately to one chat was cited as "Projektwissen", i.e. as office
 * knowledge filed against the project, because a `('s_', 'projekt')` prefix row
 * was the only guess available.
 */

import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { SourceCard } from './SourceCard'
import type { CitedDocument } from '../../lib/citations'
import type { Shelf } from '../../lib/source-kinds'

/**
 * A retrieved project-KIND document, parameterised by the SHELF the wire
 * carried. The two axes are deliberately independent: a session attachment is
 * project-ish material (it paints in that family) but is not project knowledge.
 */
const document = (shelf: Shelf | undefined): CitedDocument => ({
  id: 'doc:s_9f2a4c:grundriss.pdf',
  title: 'Grundriss',
  fileName: 'Grundriss.pdf',
  collection: 's_9f2a4c',
  shelf,
  kind: 'projekt',
  tint: 'project',
  loci: [{ key: 'p:2', page: 2, isCited: true, number: 1 }],
})

const renderCard = (shelf: Shelf | undefined) =>
  render(<SourceCard document={document(shelf)} hitLabel="1 Treffer" gapLabel="0 Treffer" />)

describe('SourceCard — provenance tab', () => {
  test('a private session attachment is not labelled Projektwissen', () => {
    renderCard('session')

    expect(screen.getByText('Private Sitzung')).toBeInTheDocument()
    expect(screen.queryByText('Projektwissen')).not.toBeInTheDocument()
  })

  test('a project document is labelled Projektwissen', () => {
    renderCard('project')

    expect(screen.getByText('Projektwissen')).toBeInTheDocument()
  })

  test('an org Archiv document is labelled Büroarchiv', () => {
    renderCard('archiv')

    expect(screen.getByText('Büroarchiv')).toBeInTheDocument()
  })

  test('a document with no shelf claims none — it falls back to its display kind', () => {
    // The collection id on the fixture is `s_9f2a4c`; before ADR-0047 that
    // prefix alone put "Projektwissen" on this tab. With the shelf absent the
    // card states only the ADR-0026 stratum, which is a claim about colour
    // family, not about whose shelf the file sits on.
    renderCard(undefined)

    expect(screen.getByText('Projektwissen')).toBeInTheDocument()
    expect(screen.queryByText('Private Sitzung')).not.toBeInTheDocument()
  })
})
