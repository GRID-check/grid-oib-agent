/**
 * A plan cited for a depiction opens with that depiction marked (issue #433).
 *
 * What the citation dialog hands the viewer is the claim here, so the viewer is
 * replaced by a recorder: its own drawing is `pdf-document-view.spec.tsx`'s
 * business. A locus with regions gets them and NO text search, because its
 * snippet is the vision model's description of the drawing, not words on the
 * page; a locus without keeps the text search it always had.
 */

import { render } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import type { PdfViewerDialogProps } from '@/features/knowledge/components/pdf-viewer-dialog'
import { buildCitationModel, resolveCitationTarget } from '../lib/citations'
import type { CitationSource } from '../types'
import { CitationDocumentDialog } from './SourcePreview'

const seen = vi.hoisted(() => ({ props: null as PdfViewerDialogProps | null }))

vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: (props: PdfViewerDialogProps) => {
    seen.props = props
    return null
  },
}))

const FILE = 'einreichplan_og.pdf'

const open = (overrides: Partial<CitationSource>) => {
  const [document] = buildCitationModel({
    citations: [
      {
        id: 'c-1',
        content: `[KB] ${FILE}, p.4`,
        timestamp: new Date('2026-09-29T10:00:00Z'),
        citationKey: `${FILE}, p.4`,
        fileName: FILE,
        kind: 'projekt',
        page: 4,
        isCited: true,
        snippet: '[DRAWING from page 4] Grundriss 1. OG mit Sitztreppe zum Innenhof.',
        ...overrides,
      },
    ],
  })
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
      src="/plan.pdf"
      open
      onOpenChange={() => {}}
    />,
  )
  return seen.props!
}

describe('CitationDocumentDialog and a cited region', () => {
  test('hands the viewer the region, at its page, and no text to hunt for', () => {
    const regions = [{ box: [0.08, 0.12, 0.62, 0.71] as [number, number, number, number], label: 'Grundriss 1. OG' }]
    const props = open({ regions })
    expect(props.page).toBe(4)
    expect(props.regions).toEqual(regions)
    expect(props.highlight).toBeUndefined()
    expect(props.highlightColor).toBe('var(--source-project)')
  })

  test('a passage without a region keeps the text search', () => {
    const props = open({ snippet: 'Die Fluchtwege im Obergeschoss sind freizuhalten.' })
    expect(props.regions).toBeUndefined()
    expect(props.highlight).toBe('Die Fluchtwege im Obergeschoss sind freizuhalten.')
  })
})
