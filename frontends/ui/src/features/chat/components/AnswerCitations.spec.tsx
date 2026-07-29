/**
 * A shared citation link opens ONE document.
 *
 * Every answer on screen reads the same `?cite=` parameter against its own
 * documents, so a source cited twice in a conversation resolved twice — and two
 * dialogs for one document stacked on each other is not a viewing session. The
 * same holds for closing it: the link is spent, not passed to the next answer.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect } from 'vitest'
import { AnswerCitations } from './AnswerCitations'
import { buildCitationModel, encodeCitationLink } from '../lib/citations'
import type { CitationSource } from '../types'

const at = new Date('2026-07-28T12:00:00Z')
const OIB = 'oib-rl_2.1_ausgabe_mai_2023.pdf'

const locus = (page: number, number: number): CitationSource => ({
  id: `c${number}`,
  content: `[KB] ${OIB}, p.${page}`,
  citationKey: `${OIB}, p.${page}`,
  fileName: OIB,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2.1, Ausgabe Mai 2023',
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  page,
  number,
  isCited: true,
  timestamp: at,
})

// Two answers citing the same source build their OWN model from their own
// citation payload, so the models are equivalent but not the same objects — the
// case a reference-based comparison would wave through.
const answered = () => buildCitationModel({ citations: [locus(5, 1), locus(18, 2)] })
const first = answered()
const second = answered()
const link = encodeCitationLink({ document: first[0]!, locus: first[0]!.loci[1]! })

// The viewer itself is not what this asserts — how MANY of it are mounted is.
vi.mock('./SourcePreview', () => ({
  SourceDocumentDialog: ({
    citation,
    onClose,
  }: {
    citation: { document: { id: string } }
    onClose: () => void
  }) => (
    <div data-testid="document-dialog">
      {citation.document.id}
      <button type="button" onClick={onClose}>
        schließen
      </button>
    </div>
  ),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`cite=${link}`),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/chat',
}))

describe('an answer arriving on a shared citation link', () => {
  test('one link opens one dialog, however many answers hold the document', () => {
    render(
      <>
        <AnswerCitations documents={first} anchorPrefix="src-m1-">
          <p>Erste Antwort</p>
        </AnswerCitations>
        <AnswerCitations documents={second} anchorPrefix="src-m2-">
          <p>Zweite Antwort</p>
        </AnswerCitations>
      </>
    )

    const dialogs = screen.getAllByTestId('document-dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveTextContent(first[0]!.id)
  })

  test('closing the dialog does not hand the link to the next answer', async () => {
    render(
      <>
        <AnswerCitations documents={first} anchorPrefix="src-m1-">
          <p>Erste Antwort</p>
        </AnswerCitations>
        <AnswerCitations documents={second} anchorPrefix="src-m2-">
          <p>Zweite Antwort</p>
        </AnswerCitations>
      </>
    )

    await userEvent.click(screen.getByRole('button', { name: 'schließen' }))

    expect(screen.queryByTestId('document-dialog')).toBeNull()
  })

  test('an answer that does not hold the linked document opens nothing', () => {
    const other = buildCitationModel({
      citations: [{ ...locus(1, 1), fileName: 'Andere.pdf', citationKey: 'Andere.pdf, p.1' }],
    })

    render(
      <AnswerCitations documents={other} anchorPrefix="src-m3-">
        <p>Antwort ohne dieses Dokument</p>
      </AnswerCitations>
    )

    expect(screen.queryByTestId('document-dialog')).toBeNull()
  })
})
