import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { buildCitationModel, type CitationRef } from '../lib/citations'
import type { CitationSource } from '../types'
import {
  ReportSourcePreviewChip,
  SourcePreviewChip,
  resetSourcePreviewIndexCache,
} from './SourcePreview'

vi.mock('../store', () => ({
  useChatStore: (selector: (s: { projectId: string | null }) => unknown) =>
    selector({ projectId: 'project-1' }),
}))

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

/** Routes the module's read APIs (project docs, org Archiv, base corpus); anything else 404s. */
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input)
  if (url.startsWith('/api/documents?projectId=')) {
    return Promise.resolve(
      jsonResponse({
        documents: [
          { id: 'doc-1', filename: 'Brandschutzkonzept.pdf', contentType: 'application/pdf' },
        ],
      })
    )
  }
  if (url === '/api/knowledge-base') {
    return Promise.resolve(
      jsonResponse({
        files: [{ fileName: 'oib-rl_2.pdf', state: 'ingested', origin: 'corpus' }],
      })
    )
  }
  if (url === '/api/archiv/documents') {
    return Promise.resolve(
      jsonResponse({
        documents: [
          { id: 'archiv-1', filename: 'Bueroe_Detail_Attika.pdf', contentType: 'application/pdf' },
        ],
      })
    )
  }
  if (url === '/api/documents/doc-1/preview' || url === '/api/documents/archiv-1/preview') {
    return Promise.resolve(jsonResponse({ url: 'https://storage.example/presigned.pdf' }))
  }
  return Promise.resolve({ ok: false, json: async () => ({}) })
})

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: 'c-1',
  url: '',
  content: '',
  timestamp: new Date('2026-07-17T10:00:00Z'),
  ...overrides,
})

/**
 * Build the reference a chip renders through the REAL model, so these tests
 * exercise the same identity/title/tint resolution production does rather than
 * a hand-shaped object no producer would ever emit.
 */
const ref = (overrides: Partial<CitationSource>): CitationRef => {
  const [document] = buildCitationModel({ citations: [citation(overrides)] })
  if (!document) throw new Error('fixture produced no document')
  return { document, locus: document.loci[0] }
}

describe('SourcePreviewChip', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('web/RIS citations keep linking out and trigger no index fetch', () => {
    render(
      <SourcePreviewChip
        citation={ref({ kind: 'web', origin: 'web', url: 'https://example.com/article' })}
      />
    )

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.com/article')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a RIS source with a bindingness note opens a popover (note + tier + open-in-RIS) instead of linking out', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        citation={ref({
          title: 'WBTV',
          kind: 'baurecht',
          lane: 'baurecht_land',
          origin: 'ris',
          url: 'https://www.ris.bka.gv.at/x',
          laneLabel: 'Landesrecht',
          bindingNote: 'Macht die OIB-Richtlinien in Wien verbindlich.',
        })}
      />
    )

    // Not a bare link — it is a popover trigger, so the bindingness is reachable.
    expect(screen.queryByRole('link')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Preview source: WBTV' }))

    expect(await screen.findByText('Binding effect')).toBeInTheDocument()
    expect(screen.getByText('Macht die OIB-Richtlinien in Wien verbindlich.')).toBeInTheDocument()
    expect(screen.getByText('Landesrecht')).toBeInTheDocument()
    // The outbound RIS link lives inside the popover as an explicit action.
    expect(screen.getByRole('link', { name: /Open in RIS/i })).toHaveAttribute(
      'href',
      'https://www.ris.bka.gv.at/x'
    )
  })

  test('a KB citation resolving to a project document opens the document dialog', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        citation={ref({
          content: '[KB] Brandschutzkonzept.pdf, p.3',
          citationKey: 'Brandschutzkonzept.pdf, p.3',
          fileName: 'Brandschutzkonzept.pdf',
          collection: 'proj_1',
          kind: 'projekt',
          page: 3,
        })}
      />
    )

    // The chip upgrades to a button once the resolution index has loaded.
    // The chip names the document, not its storage filename.
    const chip = await screen.findByRole('button', {
      name: 'Preview source: Brandschutzkonzept',
    })
    await user.click(chip)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Brandschutzkonzept')).toBeInTheDocument()
    expect(within(dialog).getByText('Project document')).toBeInTheDocument()
    // The presigned preview URL was fetched for the project document.
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/preview')
  })

  test('a citation resolving to an org Archiv document opens it too', async () => {
    // Buero-kind citations were structurally unopenable: the preview index
    // never listed the Archiv, so an Archiv document always degraded to a dead
    // info popover even though the preview route would have served it.
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        citation={ref({
          content: '[KB] Bueroe_Detail_Attika.pdf, p.2',
          citationKey: 'Bueroe_Detail_Attika.pdf, p.2',
          fileName: 'Bueroe_Detail_Attika.pdf',
          collection: 'archiv_1',
          kind: 'buero',
          lane: 'buero',
          page: 2,
        })}
      />
    )

    const chip = await screen.findByRole('button', {
      name: 'Preview source: Bueroe Detail Attika',
    })
    await user.click(chip)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/archiv-1/preview')
  })

  test('an unresolvable KB citation with a passage opens an info popover — no viewer', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        citation={ref({
          content: '[KB] unbekannt.pdf\nZitierter Absatz.',
          citationKey: 'unbekannt.pdf',
          fileName: 'unbekannt.pdf',
          kind: 'projekt',
        })}
      />
    )

    // The chip stays inert until the resolution index answers, then upgrades to
    // the info popover — it never settles into the weaker affordance early.
    await user.click(await screen.findByRole('button', { name: 'Preview source: Unbekannt' }))

    expect(await screen.findByText('Cited passage')).toBeInTheDocument()
    expect(screen.getByText('Zitierter Absatz.')).toBeInTheDocument()
    // No document viewer opened (the popover itself carries role="dialog",
    // so assert on the viewer's frame instead).
    expect(document.querySelector('iframe')).toBeNull()
  })

  test('the popover names the canonical kind, not the coarser origin token', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        // `origin` is derived kb/ris/web only, so a knowledge-base copy of a
        // legal text used to read "Project knowledge" in the popover while the
        // chip beside it wore a RIS badge and a Baurecht lane.
        citation={ref({
          kind: 'baurecht',
          content: '[KB] wr_bauordnung.pdf\n§ 119.',
          citationKey: 'wr_bauordnung.pdf',
          fileName: 'wr_bauordnung.pdf',
        })}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Preview source: Wr bauordnung' }))

    expect(await screen.findByText('Building law & guidelines')).toBeInTheDocument()
    expect(screen.queryByText('Project knowledge')).toBeNull()
  })

  test('a source with nothing beyond its name stays a plain, non-interactive chip', () => {
    const [document] = buildCitationModel({
      cards: [{ type: 'legal_basis', law: 'OIB-Richtlinie 2' } as never],
    })
    render(<SourcePreviewChip citation={{ document: document! }} />)

    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ReportSourcePreviewChip', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders a View affordance for a resolvable base-corpus entry', async () => {
    render(<ReportSourcePreviewChip locatorText="oib-rl_2.pdf, p.12" />)

    expect(
      await screen.findByRole('button', { name: 'Preview source: OIB-Richtlinie 2' })
    ).toHaveTextContent('View')
  })

  test('renders nothing for an unresolvable entry', async () => {
    const { container } = render(<ReportSourcePreviewChip locatorText="nicht-vorhanden.pdf" />)

    // Give the index a tick to load; the chip must still render nothing.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('a document read at several pages', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('every cited page is reachable from the dialog, not just the first', async () => {
    // The defect: a document read at pages 3 and 9 opened at 3 and offered no
    // way to reach 9 — verifying the second citation meant closing the viewer,
    // hunting for another chip, and hoping. Each Fundstelle is now a button.
    const user = userEvent.setup()
    const [document] = buildCitationModel({
      citations: [
        citation({
          content: '[KB] Brandschutzkonzept.pdf, p.3',
          citationKey: 'Brandschutzkonzept.pdf, p.3',
          fileName: 'Brandschutzkonzept.pdf',
          collection: 'proj_1',
          kind: 'projekt',
          page: 3,
          number: 1,
          isCited: true,
        }),
        citation({
          id: 'c-2',
          content: '[KB] Brandschutzkonzept.pdf, p.9',
          citationKey: 'Brandschutzkonzept.pdf, p.9',
          fileName: 'Brandschutzkonzept.pdf',
          collection: 'proj_1',
          kind: 'projekt',
          page: 9,
          number: 2,
          isCited: true,
        }),
      ],
    })

    render(<SourcePreviewChip citation={{ document: document! }} />)
    await user.click(
      await screen.findByRole('button', { name: 'Preview source: Brandschutzkonzept' })
    )

    const dialog = await screen.findByRole('dialog')
    const rail = within(dialog).getByRole('group', { name: /passages in this document/i })
    const pages = within(rail).getAllByRole('button')

    expect(pages.map((button) => button.textContent)).toEqual(['p. 3[1]', 'p. 9[2]'])
    // The one being read is marked, so the rail says WHERE you are, not just
    // where you could go.
    expect(pages[0]).toHaveAttribute('aria-current', 'true')

    await user.click(pages[1]!)
    expect(pages[1]).toHaveAttribute('aria-current', 'true')
    expect(pages[0]).not.toHaveAttribute('aria-current')
  })

  test('a document read at ONE page shows no rail — there is nowhere else to go', async () => {
    const user = userEvent.setup()
    const [document] = buildCitationModel({
      citations: [
        citation({
          content: '[KB] Brandschutzkonzept.pdf, p.3',
          citationKey: 'Brandschutzkonzept.pdf, p.3',
          fileName: 'Brandschutzkonzept.pdf',
          collection: 'proj_1',
          kind: 'projekt',
          page: 3,
          isCited: true,
        }),
      ],
    })

    render(<SourcePreviewChip citation={{ document: document! }} />)
    await user.click(
      await screen.findByRole('button', { name: 'Preview source: Brandschutzkonzept' })
    )

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('group', { name: /passages/i })).toBeNull()
  })
})
