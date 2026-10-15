/**
 * „Im Büro behandelt" from a citation: the join between the citation viewer,
 * the rail and the stage. The viewer is a recorder (its drawing is
 * `pdf-document-view.spec.tsx`'s business); what is pinned is what the dialog
 * asks for and what it hands the viewer:
 *
 * - the header action asks about the cited Fundstelle as CITED text (its
 *   stored chunk stands in, nothing is embedded), from the cited document and
 *   the chat's project;
 * - a selection asks as SELECTED text;
 * - the rail replaces the Fundstellen, and a passage opened from it takes the
 *   stage in the same dialog, at its page, marked, without the citation's copy
 *   actions; going back restores the citation.
 */

import { fireEvent, render, screen } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PdfViewerDialogProps } from '@/features/knowledge/components/pdf-viewer-dialog'
import type { SimilarPassagesRequest, SimilarPassagesResponse } from '@/lib/similar-passages/types'
import { buildCitationModel, resolveCitationTarget } from '../lib/citations'
import type { CitationSource } from '../types'
import { CitationDocumentDialog } from './SourcePreview'

const seen = vi.hoisted(() => ({ props: null as PdfViewerDialogProps | null, mounts: 0 }))

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))
vi.mock('../store', () => ({
  useChatStore: (select: (state: { projectId: string | null }) => unknown) => select({ projectId: 'p-chat' }),
}))
vi.mock('@/features/knowledge/components/pdf-viewer-dialog', async () => {
  const { useEffect } = await import('react')
  return {
    PdfViewerDialog: (props: PdfViewerDialogProps) => {
      seen.props = props
      useEffect(() => {
        seen.mounts += 1
      }, [])
      return (
        <div>
          {props.headerActions}
          {props.aside}
          <button type="button" onClick={() => props.onFindSimilar?.({ text: 'Laufbreite der Fluchttreppe', page: 7 })}>
            select
          </button>
        </div>
      )
    },
  }
})

const FILE = 'oib-richtlinie-4.pdf'
const CITED = 'Treppen in Fluchtwegen müssen eine nutzbare Laufbreite von mindestens 1,20 m aufweisen.'

const RESPONSE: SimilarPassagesResponse = {
  origin: 'point',
  projectsSearched: 1,
  groups: [
    {
      kind: 'project',
      project: { id: 'p-2', name: 'Schule Baden', status: 'closed' },
      documents: [
        {
          documentId: 'doc-hit',
          filename: 'Bescheid.pdf',
          displayName: null,
          contentType: 'application/pdf',
          stand: null,
          passages: [{ page: 3, snippet: 'Laufbreite 1,20 m', score: 0.9 }],
        },
      ],
    },
  ],
}

const asked: SimilarPassagesRequest[] = []

const openCitation = () => {
  const source: CitationSource = {
    id: 'c-1',
    content: `[KB] ${FILE}, p.2`,
    timestamp: new Date('2026-10-13T09:00:00Z'),
    citationKey: `${FILE}, p.2`,
    fileName: FILE,
    collection: 'oib_knowledge',
    kind: 'baurecht',
    page: 2,
    isCited: true,
    number: 1,
    snippet: CITED,
  }
  const [document] = buildCitationModel({ citations: [source] })
  if (!document) throw new Error('fixture produced no document')
  const locus = document.loci[0]
  const target = resolveCitationTarget(document, { locus, baseCorpusFiles: [FILE] })
  if (target.kind !== 'document') throw new Error('fixture did not resolve to a document')
  render(
    <CitationDocumentDialog
      target={target}
      citation={{ document, locus }}
      activeLocus={locus}
      onSelectLocus={() => {}}
      src="/oib.pdf"
      open
      onOpenChange={() => {}}
      similarFixtures={{
        load: async (request) => {
          asked.push(request)
          return RESPONSE
        },
        srcOf: (id) => `/fixture/${id}.pdf`,
      }}
    />
  )
}

beforeEach(() => {
  asked.length = 0
  seen.props = null
  seen.mounts = 0
})

describe('CitationDocumentDialog and similar passages', () => {
  test('asks about the cited Fundstelle as cited text, from the cited document and the chat’s project', async () => {
    openCitation()
    fireEvent.click(screen.getByRole('button', { name: 'Check where your office has dealt with this passage' }))

    expect(await screen.findByRole('button', { name: 'Open Bescheid.pdf, page 3' })).toBeTruthy()
    expect(asked).toEqual([
      {
        document: { kind: 'base', fileName: FILE },
        passage: { text: CITED, page: 2, cited: true },
        projectId: 'p-chat',
      },
    ])
  })

  test('asks about a selection as selected text', async () => {
    openCitation()
    fireEvent.click(screen.getByRole('button', { name: 'select' }))
    await screen.findByRole('button', { name: 'Open Bescheid.pdf, page 3' })
    expect(asked[0]?.passage).toEqual({ text: 'Laufbreite der Fluchttreppe', page: 7, cited: false })
  })

  test('opens a similar passage on the same stage, marked, and goes back to the citation', async () => {
    openCitation()
    fireEvent.click(screen.getByRole('button', { name: 'Check where your office has dealt with this passage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Bescheid.pdf, page 3' }))

    expect(seen.props).toMatchObject({
      src: '/fixture/doc-hit.pdf',
      fileName: 'Bescheid.pdf',
      page: 3,
      highlight: 'Laufbreite 1,20 m',
      highlightColor: 'var(--source-project)',
      quoteFormat: undefined,
      onFindSimilar: undefined,
    })
    expect(screen.queryByRole('button', { name: 'Check where your office has dealt with this passage' })).toBeNull()
    // One dialog throughout: swapping it would remount the rail and search again.
    expect(seen.mounts).toBe(1)
    expect(asked).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Back to the passage' }))
    expect(seen.props).toMatchObject({ src: '/oib.pdf', page: 2, highlight: CITED })
  })

  test('closing the rail brings back the Fundstellen', async () => {
    openCitation()
    fireEvent.click(screen.getByRole('button', { name: 'Check where your office has dealt with this passage' }))
    await screen.findByRole('button', { name: 'Open Bescheid.pdf, page 3' })
    fireEvent.click(screen.getByRole('button', { name: 'Close “Handled in your office”' }))
    expect(screen.queryByTestId('similar-passages')).toBeNull()
    expect(screen.getByRole('navigation')).toBeTruthy()
  })
})
