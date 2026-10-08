import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { FAKE_FRAME_WIDTH, fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { FilePreviewPane } from './file-preview-pane'
import { CurrentProjectProvider } from '@/features/projects/lib/current-project'

/**
 * pdf.js, stood in for by the shared fake, plus a record of every URL the
 * viewer opened: which address the pane hands the viewer (the same-origin
 * stream, not the presigned link) is the half of the contract this file owns.
 */
const pdf = vi.hoisted(
  (): FakePdfState & { opened: string[] } => ({ fail: false, pages: [], destroyed: 0, opened: [] })
)

vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => {
  const fake = fakePdfjsRuntime(pdf)
  return {
    ...fake,
    loadPdfjs: async () => {
      const runtime = await fake.loadPdfjs()
      return {
        getDocument: (params: { url: string }) => {
          pdf.opened.push(params.url)
          return runtime.getDocument()
        },
      }
    },
  }
})

/** Fresh fake state and observers that report the well on screen (or not). */
const useInlineViewer = ({ intersecting = true }: { intersecting?: boolean } = {}) => {
  let restore = () => {}
  beforeEach(() => {
    pdf.fail = false
    pdf.pages = [{ items: [] }]
    pdf.opened = []
    restore = installLayoutObservers({ frameWidth: FAKE_FRAME_WIDTH, intersecting })
  })
  afterEach(() => restore())
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams(),
}))

/**
 * The model viewport, stood in for. Mounting the real one here would test the
 * BIM subsystem (which has its own specs); what this file must prove is that
 * the pane routes an `.ifc` to it AT ALL, and routes nothing else there.
 */
vi.mock('@/features/bim/components/ifc-file-preview', () => ({
  IfcFilePreview: (props: { documentId: string; filename: string; projectId: string }) => (
    <div
      data-testid="ifc-file-preview"
      data-document={props.documentId}
      data-filename={props.filename}
      data-project={props.projectId}
    />
  ),
}))

describe('FilePreviewPane', () => {
  const mockFile = {
    id: 'doc-1',
    filename: 'plan.pdf',
    displayName: null,
    fileSize: 1048576,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders file metadata', () => {
    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
    expect(screen.getByText('plan.pdf')).toBeDefined()
    expect(screen.getByText(/1 MB/i)).toBeDefined()
  })

  it("names a closed project's file as such, under its name (ADR-0088)", () => {
    const closed = { id: 'proj-1', name: 'Seestadt D12', status: 'closed' as const, closedAt: null, readsBecauseClosed: false }
    const { unmount } = render(
      <CurrentProjectProvider value={closed}>
        <FilePreviewPane file={mockFile} projectId="proj-1" />
      </CurrentProjectProvider>
    )
    expect(screen.getByText('Seestadt D12 · closed')).toBeDefined()
    unmount()

    render(
      <CurrentProjectProvider value={{ ...closed, status: 'active' }}>
        <FilePreviewPane file={mockFile} projectId="proj-1" />
      </CurrentProjectProvider>
    )
    expect(screen.queryByText('Seestadt D12 · closed')).toBeNull()
  })

  it("does not mark an Archiv file previewed inside a closed project", () => {
    render(
      <CurrentProjectProvider value={{ id: 'proj-1', name: 'Seestadt D12', status: 'closed', closedAt: null, readsBecauseClosed: false }}>
        <FilePreviewPane file={mockFile} scope="archiv" />
      </CurrentProjectProvider>
    )
    expect(screen.queryByText('Seestadt D12 · closed')).toBeNull()
  })

  /**
   * The header is the same shape on every document, so it can be learned: the
   * name, two chips that say which document it is, and the four controls that
   * act on the file. Before this, ten things fought for one row and five were
   * conditional, so the chrome reflowed as the reader moved between files.
   */
  it('keeps what acts on the file in the header, and what Piloti made of it in the rail', () => {
    render(
      <FilePreviewPane
        file={{ ...mockFile, tags: ['Grundriss'] }}
        projectId="proj-1"
        canCollaborate
        onClose={() => undefined}
      />
    )

    const header = screen.getByRole('heading', { name: 'plan.pdf' }).parentElement?.parentElement
    expect(header).not.toBeNull()
    const chrome = within(header!)

    // Act on the file.
    expect(chrome.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(chrome.getByTestId('document-actions-trigger')).toBeInTheDocument()
    expect(chrome.getByRole('button', { name: 'Close preview' })).toBeInTheDocument()
    // Which document it is — the category, as a chip under the name. No
    // „Citable" chip: this document is citable like almost every other, and a
    // badge that appears on everything distinguishes nothing.
    expect(chrome.getByText('Grundriss')).toBeInTheDocument()
    expect(screen.queryByText('Citable')).toBeNull()

    // What Piloti made of it, and who owns it — the rail's, not the chrome's.
    expect(chrome.queryByRole('button', { name: 'Discuss' })).toBeNull()
    expect(chrome.queryByRole('button', { name: 'Ask a colleague' })).toBeNull()
    expect(chrome.queryByText('Responsible')).toBeNull()
    expect(screen.getByRole('button', { name: 'Discuss' })).toBeInTheDocument()
    expect(screen.getByText('Responsible')).toBeInTheDocument()
  })

  /**
   * Both chips used to be rows in the rail as well. The same fact stated twice
   * on one surface reads as two facts, so the rows went when the chips came.
   */
  /**
   * The status chip earns its place only when the answer is not the default.
   * „Zitierbar" is true of almost every document, so a badge saying so
   * appeared on everything and therefore distinguished nothing; the states
   * that change what the reader can do next are the ones worth a chip, and
   * each of them is the reason the rail's Ask button is grey.
   */
  it('shows the status chip only when Piloti cannot quote the document', () => {
    const { unmount } = render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
    expect(screen.queryByText('Citable')).toBeNull()
    unmount()

    render(<FilePreviewPane file={{ ...mockFile, status: 'processing' }} projectId="proj-1" />)
    expect(screen.getAllByText('Reading')).toHaveLength(1)
  })

  it('states the status and the category once each', () => {
    render(<FilePreviewPane file={{ ...mockFile, status: 'failed', tags: ['Grundriss'] }} projectId="proj-1" />)

    expect(screen.getAllByText('Failed')).toHaveLength(1)
    expect(screen.queryByText('Status')).toBeNull()
    expect(screen.queryByText('Document type')).toBeNull()
  })

  /**
   * A re-upload that fails to index keeps the previous version's passages in
   * search, while the row already points at the new bytes. Saying only
   * "failed" left the reader to discover that the answers quote a file the
   * download no longer returns.
   */
  it('says the previous version is still searched when a new version failed', () => {
    const failed = { ...mockFile, status: 'failed', errorMessage: 'PDF is encrypted' }
    const { unmount } = render(
      <FilePreviewPane file={{ ...failed, versionState: 'published', versionCount: 2 }} projectId="proj-1" />
    )
    expect(screen.getByText("Piloti couldn't read this document, so search can't find it.")).toBeInTheDocument()
    expect(screen.getByText(/still use the previous version/)).toBeInTheDocument()
    unmount()

    // A first upload that failed has no previous version to speak of.
    render(<FilePreviewPane file={{ ...failed, versionState: 'published', versionCount: 1 }} projectId="proj-1" />)
    expect(screen.queryByText(/still use the previous version/)).toBeNull()
  })

  it('offers an expand affordance for a PDF once its preview URL has loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.test/plan.pdf' }),
    } as Response)

    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

    expect(await screen.findByRole('button', { name: /open large preview/i })).toBeDefined()
  })

  it('names the format in the Type row and keeps the MIME type in its tooltip', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) } as Response)

    render(
      <FilePreviewPane
        file={{ ...mockFile, filename: 'Vertrag.docx', contentType: docx }}
        projectId="proj-1"
      />
    )

    const type = screen.getByText('Word document')
    expect(type.getAttribute('title')).toBe(docx)
    expect(screen.queryByText(docx)).toBeNull()
  })

  it('offers the expand affordance for an image once its preview URL has loaded (FB-15a)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.test/diagram.png' }),
    } as Response)

    render(
      <FilePreviewPane
        file={{ ...mockFile, filename: 'diagram.png', contentType: 'image/png' }}
        projectId="proj-1"
      />
    )

    await waitFor(() => expect(screen.getByAltText('diagram.png')).toBeDefined())
    expect(await screen.findByRole('button', { name: /open large preview/i })).toBeDefined()
  })

  it('falls back to the failed caption and a retry action when the preview image cannot load', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.test/expired.png' }),
    } as Response)

    render(
      <FilePreviewPane
        file={{ ...mockFile, filename: 'diagram.png', contentType: 'image/png' }}
        projectId="proj-1"
      />
    )

    // The BFF handed out a presigned link, but it is expired/unreachable by the
    // time the browser fetches the bytes.
    fireEvent.error(await screen.findByAltText('diagram.png'))

    expect(await screen.findByText(/preview couldn't be loaded/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
  })

  it('opens the large preview dialog when the expand affordance is clicked', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.test/plan.pdf' }),
    } as Response)

    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: /open large preview/i }))

    // The PdfViewerDialog exposes an "Open in new tab" link only once open.
    expect(await screen.findByRole('link', { name: /open in new tab/i })).toBeDefined()
  })

  describe('a PDF, in the app\'s own viewer', () => {
    useInlineViewer()

    const presigned = () =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://example.test/plan.pdf' }),
      } as Response)

    /**
     * Android Chrome has no inline PDF renderer: a frame on the presigned URL
     * was a blank box or a download. pdf.js draws the pages itself, and it
     * FETCHES them, so it reads the same-origin stream.
     */
    it('renders the pages with pdf.js on the same-origin stream, not in a frame', async () => {
      presigned()
      const { container } = render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      await waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(1))
      expect(pdf.opened).toEqual(['/api/documents/doc-1/file'])
      expect(container.querySelector('iframe')).toBeNull()
      expect(screen.getByRole('group', { name: 'plan.pdf' })).toBeInTheDocument()
    })

    it('opens one document at a time: the enlarged view borrows it from the pane', async () => {
      const user = userEvent.setup()
      presigned()
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      await screen.findByRole('group', { name: 'plan.pdf' })

      await user.click(screen.getByRole('button', { name: /open large preview/i }))

      await screen.findByRole('link', { name: /open in new tab/i })
      await waitFor(() => expect(screen.getAllByTestId('pdf-scroll')).toHaveLength(1))
      expect(within(screen.getByRole('dialog')).getByTestId('pdf-scroll')).toBeInTheDocument()
    })

    it('says it could not load, and retries, when the viewer cannot open the bytes', async () => {
      const user = userEvent.setup()
      presigned()
      pdf.fail = true
      const { container } = render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      expect(await screen.findByText(/preview couldn't be loaded/i)).toBeInTheDocument()
      expect(container.querySelector('iframe')).toBeNull()
      expect(screen.queryByRole('button', { name: /open large preview/i })).toBeNull()

      pdf.fail = false
      await user.click(screen.getByRole('button', { name: /try again/i }))
      await waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(1))
    })
  })

  describe('a PDF in a well that is not on screen yet', () => {
    useInlineViewer({ intersecting: false })

    it('does not start pdf.js for a document nobody can see', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://example.test/plan.pdf' }),
      } as Response)
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      await screen.findByRole('button', { name: /open large preview/i })
      expect(screen.queryByTestId('pdf-scroll')).toBeNull()
      expect(pdf.opened).toEqual([])
    })
  })

  it('does not offer the expand affordance for a non-previewable file', async () => {
    render(
      <FilePreviewPane
        file={{ ...mockFile, filename: 'notes.txt', contentType: 'text/plain' }}
        projectId="proj-1"
      />
    )

    // text/plain is not previewable, so no preview URL loads and no expand button.
    expect(screen.queryByRole('button', { name: /open large preview/i })).toBeNull()
  })

  describe('where the document stands, in the header', () => {
    it('says the state beside the name once the document has a history', () => {
      render(<FilePreviewPane file={{ ...mockFile, versionState: 'in_review', versionCount: 2 }} />)

      // „Freigabe und Fassungen" is last in the rail and shut; the one WORD
      // belongs with the name, so nobody scrolls a rail to its end to learn
      // whether the office stands behind the document in front of them.
      expect(screen.getByTestId('file-preview-lifecycle-badge')).toHaveTextContent('In review')
    })

    it('stays silent on an ordinary upload', () => {
      // One version, born published, a person put it there. A chip here would
      // appear on every document in the library and distinguish nothing —
      // `showsVersionStateBadge`, the same rule the file card obeys.
      render(<FilePreviewPane file={{ ...mockFile, versionState: 'published', versionCount: 1 }} />)

      expect(screen.queryByTestId('file-preview-lifecycle-badge')).not.toBeInTheDocument()
    })

    it('says so when the file has been taken out of the working set', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, versionState: 'published', versionCount: 1, lifecycle: 'archived' }}
        />,
      )

      // The item-level fact wins over the version's, and it is „Retired" rather
      // than „Archived": the Archiv is what a document is put INTO to become
      // office knowledge, which is the opposite of this.
      expect(screen.getByTestId('file-preview-lifecycle-badge')).toHaveTextContent('Retired')
    })
  })

  describe('"Read by Piloti" panel', () => {
    it('renders the AI summary, page and chunk counts inside the panel when present', () => {
      render(
        <FilePreviewPane
          file={{
            ...mockFile,
            summary: 'A ground-floor plan of the east wing.',
            pageCount: 4,
            chunkCount: 12,
          }}
          projectId="proj-1"
        />
      )
      expect(screen.getByText('Read by Piloti')).toBeDefined()
      expect(screen.getByText('A ground-floor plan of the east wing.')).toBeDefined()
      expect(screen.getByText('Pages')).toBeDefined()
      expect(screen.getByText('4')).toBeDefined()
      expect(screen.getByText('Passages')).toBeDefined()
      expect(screen.getByText('12')).toBeDefined()
    })

    it('lazily loads and shows per-page drawing descriptions in "Detailed information"', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/visual-details')) {
          return {
            ok: true,
            json: async () => ({
              details: [
                {
                  page: 1,
                  contentType: 'drawing',
                  drawingType: 'schnitt',
                  scale: '1:100',
                  text: 'Ein Längsschnitt.',
                },
              ],
            }),
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ url: 'https://example.test/plan.pdf' }),
        } as Response
      })

      render(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'drawing'] }}
          projectId="proj-1"
        />
      )

      // Collapsed by default: the description is not in the DOM yet.
      expect(screen.queryByText('Ein Längsschnitt.')).toBeNull()

      const toggle = screen.getByRole('button', { name: /detailed information/i })
      await userEvent.click(toggle)

      // The description is lazily fetched and rendered on expand.
      expect(await screen.findByText('Ein Längsschnitt.')).toBeDefined()
      // Per-page header shows the page number and the drawing type badge.
      expect(screen.getByText('Page 1')).toBeDefined()
      expect(screen.getByText(/· schnitt/)).toBeDefined()
    })

    it('does not show "Detailed information" when the document has no visual chunks', () => {
      render(<FilePreviewPane file={{ ...mockFile, contentTypes: ['text'] }} projectId="proj-1" />)
      expect(screen.queryByRole('button', { name: /detailed information/i })).toBeNull()
    })

    it('marks which of the sheet\'s depictions a row is when a sheet carries several', async () => {
      // Issue #440: two floor plans side by side index as two rows. Without
      // the position they read as one drawing stated twice.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/visual-details')) {
          return {
            ok: true,
            json: async () => ({
              details: [
                {
                  page: 1,
                  contentType: 'drawing',
                  drawingType: 'floor_plan',
                  scale: '1:100',
                  text: 'Erdgeschoss.',
                  segment: 0,
                  segmentCount: 2,
                },
                {
                  page: 1,
                  contentType: 'drawing',
                  drawingType: 'floor_plan',
                  scale: '1:100',
                  text: 'Obergeschoss.',
                  segment: 1,
                  segmentCount: 2,
                },
              ],
            }),
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ url: 'https://example.test/plan.pdf' }),
        } as Response
      })

      render(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'drawing'] }}
          projectId="proj-1"
        />
      )

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))
      expect(await screen.findByText('Erdgeschoss.')).toBeDefined()
      expect(screen.getByText('Obergeschoss.')).toBeDefined()
      // Language-neutral by construction: `1/2` needs no dictionary.
      expect(screen.getByText('· 1/2')).toBeDefined()
      expect(screen.getByText('· 2/2')).toBeDefined()
    })

    /** The structured half of the analysis — rooms, assemblies, quantities,
     * provenance — behind a second, advanced disclosure. */
    const mockVisualDetails = (details: unknown[]) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/visual-details')) {
          return { ok: true, json: async () => ({ details }) } as Response
        }
        return {
          ok: true,
          json: async () => ({ url: 'https://example.test/plan.pdf' }),
        } as Response
      })
    }

    const structuredDetail = {
      page: 2,
      contentType: 'drawing',
      drawingType: 'floor_plan',
      scale: '1:100',
      segment: 0,
      text: 'Grundriss des Erdgeschosses.',
      structured: {
        schemaVersion: 4,
        registry: 'architecture+general@abc123',
        segment: {
          domain: 'architecture',
          segmentType: 'floor_plan',
          title: 'EG',
          scale: '1:100',
          summary: 'Grundriss des Erdgeschosses.',
          entityGroups: [
            {
              category: 'space',
              entities: [
                { name: 'Atelier', category: 'space', role: 'Arbeiten', measure: '24,5 m²' },
              ],
            },
            // A category this build has no translation for. It must still
            // render, from its key, so a domain added on the backend needs no
            // frontend release.
            {
              category: 'site_plant',
              entities: [{ name: 'Turmkran', category: 'site_plant', role: null, measure: null }],
            },
          ],
          compositions: [
            {
              component: 'Außenwand',
              layers: [{ material: 'Stahlbeton', thickness: '20 cm', purpose: 'tragend' }],
            },
          ],
          states: [{ element: 'Bestandsmauer', state: 'existing' }],
          quantities: [
            {
              object: 'Bausubstanz erhalten',
              property: 'Anteil',
              value: '71',
              unit: '%',
              source: 'text',
              confidence: 'high',
            },
          ],
          relations: [{ subject: 'Rampe', relation: 'verbindet', object: 'Hof und Dach' }],
          annotations: [],
          source: 'visual',
          confidence: 'medium',
        },
        document: {
          title: 'Bildungscampus',
          subtitle: null,
          slogans: [],
          author: null,
          institution: null,
          supervision: null,
          location: null,
          strategies: [],
          processSteps: [],
        },
      },
    }

    it('reveals the structured analysis behind an advanced disclosure', async () => {
      mockVisualDetails([structuredDetail])
      render(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'drawing'] }}
          projectId="proj-1"
        />
      )

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))
      await screen.findByText('Grundriss des Erdgeschosses.')

      // Advanced by design: the structured values stay hidden until asked for.
      expect(screen.queryByText(/Atelier/)).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: /structured data/i }))

      expect(screen.getByText('Atelier (Arbeiten, 24,5 m²)')).toBeDefined()
      // A vocabulary term this build knows is translated…
      expect(screen.getByText('Spaces and uses')).toBeDefined()
      // …and one it has never seen is humanized from its key rather than
      // dropped, so a domain added on the backend needs no frontend release.
      expect(screen.getByText('Site plant')).toBeDefined()
      expect(screen.getByText('Turmkran')).toBeDefined()
      expect(screen.getByText('Stahlbeton 20 cm (tragend)')).toBeDefined()
      expect(screen.getByText('Bestandsmauer: existing')).toBeDefined()
      // A number keeps the meaning that makes it worth storing.
      expect(screen.getByText('Bausubstanz erhalten — Anteil')).toBeDefined()
      expect(screen.getByText('71 %')).toBeDefined()
      expect(screen.getByText('Rampe → verbindet → Hof und Dach')).toBeDefined()
      // An inferred reading must never read like a measured one.
      expect(screen.getByText('read from the drawing · confidence medium')).toBeDefined()
    })

    it('offers no advanced disclosure when there is nothing beyond the description', async () => {
      mockVisualDetails([
        {
          page: 1,
          contentType: 'image',
          drawingType: '',
          scale: '',
          segment: 0,
          text: 'Ein Baustellenfoto.',
          structured: {
            schemaVersion: 4,
            registry: 'architecture+general@abc123',
            segment: {
              domain: 'general',
              segmentType: 'photo',
              title: null,
              scale: null,
              summary: 'Ein Baustellenfoto.',
              entityGroups: [],
              compositions: [],
              states: [],
              quantities: [],
              relations: [],
              annotations: [],
              source: null,
              confidence: null,
            },
            document: {
              title: null,
              subtitle: null,
              slogans: [],
              author: null,
              institution: null,
              supervision: null,
              location: null,
              strategies: [],
              processSteps: [],
            },
          },
        },
      ])
      render(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'image'] }}
          projectId="proj-1"
        />
      )

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))
      await screen.findByText('Ein Baustellenfoto.')

      expect(screen.queryByRole('button', { name: /structured data/i })).toBeNull()
    })

    it('still renders a chunk indexed before the structured schema', async () => {
      mockVisualDetails([
        {
          page: 1,
          contentType: 'drawing',
          drawingType: 'schnitt',
          scale: '1:50',
          text: 'Ein Schnitt.',
        },
      ])
      render(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'drawing'] }}
          projectId="proj-1"
        />
      )

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))

      expect(await screen.findByText('Ein Schnitt.')).toBeDefined()
      expect(screen.queryByRole('button', { name: /structured data/i })).toBeNull()
    })

    it('renders the HITL caption and the Updated row from real metadata', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(
        screen.getByText(
          /Automatically detected on upload — your corrections improve future answers\./
        )
      ).toBeDefined()
      expect(screen.getByText('Updated')).toBeDefined()
    })

    it('shows the project row and the detected category only from real metadata', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
          projectId="proj-1"
          projectName="Stadthaus Linz"
        />
      )
      // The detected type is a chip beside the name now, not a rail row —
      // 'Grundriss' appears there and as a tag chip, and nowhere else.
      expect(screen.queryByText('Document type')).toBeNull()
      expect(screen.getAllByText('Grundriss')).toHaveLength(2)
      expect(screen.getByText('Project')).toBeDefined()
      expect(screen.getByText('Stadthaus Linz')).toBeDefined()
    })

    it('omits the project row and the category chip without the metadata', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(screen.queryByText('Grundriss')).toBeNull()
      expect(screen.queryByText('Project')).toBeNull()
      expect(screen.queryByText('Pages')).toBeNull()
      expect(screen.queryByText('Passages')).toBeNull()
    })

    it('hides the whole panel when the files-metadata-panel flag is off, keeping status/type/size', () => {
      render(
        <FilePreviewPane
          file={{
            ...mockFile,
            summary: 'A ground-floor plan of the east wing.',
            pageCount: 4,
            chunkCount: 12,
            contentTypes: ['text', 'table'],
          }}
          projectId="proj-1"
          showMetadataPanel={false}
        />
      )
      // The flag-gated panel is absent…
      expect(screen.queryByText('Read by Piloti')).toBeNull()
      expect(screen.queryByText('A ground-floor plan of the east wing.')).toBeNull()
      expect(screen.queryByText('Pages')).toBeNull()
      expect(screen.queryByText('Passages')).toBeNull()
      expect(screen.queryByText('Contents')).toBeNull()
      // …but the ungated rows stay. Status is no longer one of them: it moved
      // to the header beside the filename, because "can Piloti quote this" is
      // the first question on opening a file and it used to sit below the fold
      // in a column the flag can hide entirely. It is answered there by a chip
      // that appears only when the answer is NO — which for this citable
      // fixture means nothing at all, on either surface.
      expect(screen.queryByText('Citable')).toBeNull()
      expect(screen.queryByText('Status')).toBeNull()
      expect(screen.queryByText('Status')).toBeNull()
      expect(screen.getByText('Type')).toBeDefined()
      expect(screen.getByText('Size')).toBeDefined()
      expect(screen.getByText(/1 MB/i)).toBeDefined()
    })

    it('shows content types only when the document holds more than plain text', () => {
      const { rerender } = render(
        <FilePreviewPane file={{ ...mockFile, contentTypes: ['text'] }} projectId="proj-1" />
      )
      // Text-only → no redundant contents row.
      expect(screen.queryByText('Contents')).toBeNull()

      rerender(
        <FilePreviewPane
          file={{ ...mockFile, contentTypes: ['text', 'table'] }}
          projectId="proj-1"
        />
      )
      expect(screen.getByText('Contents')).toBeDefined()
      expect(screen.getByText('Text, Tables')).toBeDefined()
    })
  })

  describe('editable tags', () => {
    it('renders ingestion-generated tags as chips when present', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
          projectId="proj-1"
        />
      )
      expect(screen.getByText('Tags')).toBeDefined()
      // 'Grundriss' also appears as the detected document-type row value.
      expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeDefined()
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeDefined()
    })

    it('offers the add-tag input when there are no tags yet', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(screen.getByText('Tags')).toBeDefined()
      expect(screen.getByRole('textbox', { name: /add tag/i })).toBeDefined()
    })

    it('shows a read-only placeholder instead of the input when the viewer cannot manage', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" canManage={false} />)
      expect(screen.getByText('No tags')).toBeDefined()
      expect(screen.queryByRole('textbox', { name: /add tag/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /remove tag/i })).toBeNull()
    })

    it('hides tags entirely when the files-metadata-panel flag is off', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
          projectId="proj-1"
          showMetadataPanel={false}
        />
      )
      expect(screen.queryByText('Tags')).toBeNull()
      expect(screen.queryByText('Grundriss')).toBeNull()
      expect(screen.queryByText('Brandschutz')).toBeNull()
      expect(screen.queryByRole('textbox', { name: /add tag/i })).toBeNull()
    })

    it('adds a tag typed into the input on Enter: optimistic chip + PATCH shape', async () => {
      const user = userEvent.setup()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

      // Optimistic: the new chip is present immediately.
      await waitFor(() => expect(screen.getByText('Brandschutz')).toBeDefined())

      const tagsCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/documents/doc-1/tags'
      )
      expect(tagsCall).toBeDefined()
      expect(tagsCall![1]).toMatchObject({ method: 'PATCH' })
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({
        tags: ['Grundriss', 'Brandschutz'],
      })
    })

    it('offers vocabulary suggestions while typing and adds one on click', async () => {
      const user = userEvent.setup()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: [] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'schall')
      await user.click(await screen.findByRole('button', { name: 'Schallschutz' }))

      await waitFor(() => expect(screen.getByText('Schallschutz')).toBeDefined())
      const tagsCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/documents/doc-1/tags'
      )
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({
        tags: ['Schallschutz'],
      })
    })

    it('does not add free-form values outside the controlled vocabulary', async () => {
      const user = userEvent.setup()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: [] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'made-up-tag{Enter}')

      expect(screen.getByText(/no matching tag/i)).toBeDefined()
      const tagsCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/documents/doc-1/tags'
      )
      expect(tagsCall).toBeUndefined()
    })

    it('removes a tag via its × affordance and PATCHes the remainder', async () => {
      const user = userEvent.setup()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
          projectId="proj-1"
        />
      )

      await user.click(screen.getByRole('button', { name: 'Remove tag Brandschutz' }))

      await waitFor(() => expect(screen.queryByText('Brandschutz')).toBeNull())
      const tagsCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/documents/doc-1/tags'
      )
      expect(tagsCall![1]).toMatchObject({ method: 'PATCH' })
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({
        tags: ['Grundriss'],
      })
    })

    it('notifies the parent with the saved tags after a successful PATCH', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response)
      const onTagsUpdated = vi.fn()

      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss'] }}
          projectId="proj-1"
          onTagsUpdated={onTagsUpdated}
        />
      )

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

      await waitFor(() =>
        expect(onTagsUpdated).toHaveBeenCalledWith('doc-1', ['Grundriss', 'Brandschutz'])
      )
    })

    it('does not notify the parent and reverts the optimistic chip when the PATCH fails', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response)
      const onTagsUpdated = vi.fn()

      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss'] }}
          projectId="proj-1"
          onTagsUpdated={onTagsUpdated}
        />
      )

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

      // Optimistic chip appears, then reverts once the PATCH failure lands.
      // (Query the chip via its remove affordance — the plain text also occurs
      // in the suggestion list while the input is focused.)
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()
      )
      expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeDefined()
      expect(onTagsUpdated).not.toHaveBeenCalled()
    })
  })

  describe('an .ifc previews as the building', () => {
    const modelFile = {
      ...mockFile,
      id: 'doc-ifc',
      filename: 'Haus-A.ifc',
      displayName: null,
      // What the object store reports for an IFC; nothing about the preview may
      // depend on it, because exporters disagree about this string.
      contentType: 'application/octet-stream',
    }

    it('renders the model viewport instead of the "no inline preview" mock', async () => {
      render(<FilePreviewPane file={modelFile} projectId="proj-1" />)

      const preview = await screen.findByTestId('ifc-file-preview')
      expect(preview.dataset.document).toBe('doc-ifc')
      expect(preview.dataset.filename).toBe('Haus-A.ifc')
      expect(preview.dataset.project).toBe('proj-1')
      expect(screen.queryByText(/no inline preview/i)).toBeNull()
    })

    it('reads the format from the NAME, not from a tag a model may carry', async () => {
      // A model exported as "Grundriss EG.ifc" is still a model — the tag rules
      // would otherwise read that name as a floor plan and show a page mock.
      render(
        <FilePreviewPane
          file={{ ...modelFile, filename: 'Grundriss EG.ifc', tags: ['Grundriss'] }}
          projectId="proj-1"
        />
      )
      expect(await screen.findByTestId('ifc-file-preview')).toBeDefined()
    })

    it('previews the building in the org Archiv too, which has no project', async () => {
      // This used to assert the opposite, and the opposite was the bug: an
      // `.ifc` uploaded into the Archiv was parsed, indexed and listed as
      // ready, and then previewed as the grey placeholder every unreadable
      // format gets. The viewport resolves the model by DOCUMENT when no
      // project is in hand, so the shelf no longer decides whether a building
      // can be looked at.
      render(<FilePreviewPane file={modelFile} />)

      const preview = await screen.findByTestId('ifc-file-preview')
      expect(preview.dataset.document).toBe('doc-ifc')
      expect(preview.dataset.project).toBeUndefined()
      expect(screen.queryByText(/no inline preview/i)).toBeNull()
    })

    it('never routes an ordinary document to the viewport', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(screen.queryByTestId('ifc-file-preview')).toBeNull()
    })
  })

  describe('the indexed summary', () => {
    const LONG_SUMMARY =
      'Brandschutzkonzept für den Wohnbau Nord (Gebäudeklasse 4) nach OIB-Richtlinie 2. ' +
      'Zwei voneinander unabhängige Fluchtwege je Nutzungseinheit, maximale Gehweglänge 34 m, ' +
      'Brandabschnitte REI 90, Rauchableitung über die RWA im Treppenhaus.'

    /**
     * jsdom does no layout, so an element's scrollHeight is always 0 and the
     * clamp can never be observed to bite. Stubbing the two properties the
     * measurement reads is the only way to exercise either branch.
     */
    const stubOverflow = (overflows: boolean) => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(overflows ? 200 : 100)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    }

    it('offers no toggle when the whole summary already fits', () => {
      stubOverflow(false)
      render(<FilePreviewPane file={{ ...mockFile, summary: 'Kurz.' }} projectId="proj-1" />)

      expect(screen.getByText('Kurz.')).toBeDefined()
      expect(screen.queryByRole('button', { name: /full summary/i })).toBeNull()
    })

    it('clamps a long summary so the properties below it stay reachable', () => {
      stubOverflow(true)
      render(<FilePreviewPane file={{ ...mockFile, summary: LONG_SUMMARY }} projectId="proj-1" />)

      expect(screen.getByText(LONG_SUMMARY).className).toContain('line-clamp-5')
      expect(screen.getByRole('button', { name: /full summary/i })).toBeDefined()
      // The rail's other sections are rendered, not pushed out of the tree.
      expect(screen.getByText('Properties')).toBeDefined()
    })

    it('expands and collapses on request', async () => {
      stubOverflow(true)
      const user = userEvent.setup()
      render(<FilePreviewPane file={{ ...mockFile, summary: LONG_SUMMARY }} projectId="proj-1" />)

      await user.click(screen.getByRole('button', { name: /full summary/i }))
      expect(screen.getByText(LONG_SUMMARY).className).not.toContain('line-clamp-5')

      await user.click(screen.getByRole('button', { name: /show less/i }))
      expect(screen.getByText(LONG_SUMMARY).className).toContain('line-clamp-5')
    })
  })

  it('surfaces the failure reason and a retry-ingestion affordance for failed documents', async () => {
    const user = userEvent.setup()
    render(
      <FilePreviewPane
        file={{ ...mockFile, status: 'failed', errorMessage: 'Ingestion could not be started' }}
        projectId="proj-1"
      />
    )
    expect(screen.getByText('Reading failed')).toBeDefined()
    expect(screen.getByText("Reading couldn't be started. Try again.")).toBeDefined()
    expect(screen.getByRole('button', { name: /read again/i })).toBeDefined()

    // The stored text is one click away, for the admin reading over a shoulder.
    expect(screen.queryByText('Ingestion could not be started')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByTestId('preview-ingest-failure-raw')).toHaveTextContent('Ingestion could not be started')
  })

  it('says a missing vision model is a configuration problem, not the file', () => {
    render(
      <FilePreviewPane
        file={{
          ...mockFile,
          status: 'failed',
          errorMessage: 'vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY',
        }}
        projectId="proj-1"
      />
    )
    expect(screen.getByText(/need a vision model, and none is set up/)).toBeDefined()
    expect(screen.queryByText(/AIQ_VLM_API_KEY/)).toBeNull()
  })

  describe('the file operations', () => {
    it('puts them in the header, beside Download, and not in the metadata rail', async () => {
      const user = userEvent.setup()
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      // The full-width red button under the tags is gone; what is left is one
      // menu next to the other controls that act on this document.
      expect(screen.queryByRole('button', { name: /delete document/i })).toBeNull()
      await user.click(screen.getByTestId('document-actions-trigger'))

      expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
      // Download has its own button in the header — offering it twice on one
      // surface would be two controls for one job.
      expect(screen.queryByRole('menuitem', { name: /download/i })).toBeNull()
    })

    it('shows the rename, and keeps the file name reachable on the title', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, displayName: 'Einreichplan EG.pdf' }}
          projectId="proj-1"
        />
      )

      const heading = screen.getByRole('heading', { name: 'Einreichplan EG.pdf' })
      expect(heading).toHaveAttribute('title', expect.stringContaining('plan.pdf'))
    })

    it('closes itself once the document it describes has been deleted', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
      const onClose = vi.fn()
      const onDeleted = vi.fn()
      const user = userEvent.setup()
      render(
        <FilePreviewPane
          file={mockFile}
          projectId="proj-1"
          onClose={onClose}
          onDeleted={onDeleted}
        />
      )

      await user.click(screen.getByTestId('document-actions-trigger'))
      await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
      await user.click(await screen.findByTestId('document-delete-confirm'))

      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('doc-1'))
      expect(onClose).toHaveBeenCalled()
    })

    it('offers a read-only viewer nothing that mutates', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" canManage={false} />)
      expect(screen.queryByTestId('document-actions-trigger')).toBeNull()
    })
  })

  it('offers Besprechen while the file is still being read', () => {
    // It used to be greyed out here, with a hint promising a wait. The wait was
    // about the retrieval INDEX, and a conversation about a document no longer
    // depends on it: the turn reads the subject version's own bytes. Disabling
    // the control would now be withholding something that works.
    render(<FilePreviewPane file={{ ...mockFile, status: 'processing' }} projectId="proj-1" />)
    expect(screen.getByRole('button', { name: 'Discuss' })).toBeEnabled()
  })

  it('offers Besprechen once ingest has reconciled, too', () => {
    render(<FilePreviewPane file={{ ...mockFile, status: 'completed' }} projectId="proj-1" />)
    expect(screen.getByRole('button', { name: 'Discuss' })).toBeEnabled()
  })

  describe('a document that is not there any more', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('says so, and offers the one move left instead of a retry that cannot work', async () => {
      // 404 is the service's answer both for a deleted document and for one
      // this reader may no longer open (`getAccessibleDocument`: cross-tenant
      // and no-access both surface as 404). Neither changes by asking again —
      // and in a shared project both happen while somebody is mid-conversation
      // about the file.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /stop asking about it/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    })

    it('still offers the retry for a failure that might not repeat', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

      expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
      expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument()
    })
  })

  describe('an office file, through its PDF rendition (ADR-0070)', () => {
    useInlineViewer()
    afterEach(() => vi.unstubAllGlobals())

    const docx = {
      ...mockFile,
      filename: 'Raumprogramm.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    const rendition = {
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.test/_render.pdf',
        contentType: 'application/pdf',
        rendition: true,
        sourceContentType: docx.contentType,
      }),
    }

    it('says the PDF is being made while the preview route converts', async () => {
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
      vi.stubGlobal('fetch', fetchMock)
      render(<FilePreviewPane file={docx} projectId="proj-1" />)

      expect(await screen.findByText('Creating PDF preview…')).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/preview', expect.anything())
    })

    it('shows the rendition in the PDF viewer, says so, and can enlarge it', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rendition))
      const { container } = render(<FilePreviewPane file={docx} projectId="proj-1" />)

      expect(
        await screen.findByRole('button', { name: /open large preview/i })
      ).toBeInTheDocument()
      // `/file` streams the rendition for an office file, so the viewer reads
      // the same address it reads for a PDF upload.
      await waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(1))
      expect(pdf.opened).toEqual(['/api/documents/doc-1/file'])
      expect(container.querySelector('iframe')).toBeNull()
      expect(screen.getByTestId('file-preview-rendition-note')).toHaveTextContent(
        'PDF preview · Original: Raumprogramm.docx'
      )
      // Download stays: it always hands out the original.
      expect(screen.getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0)
    })

    it('decides by the extension when the stored type is empty', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rendition))
      const { container } = render(
        <FilePreviewPane file={{ ...docx, contentType: null }} projectId="proj-1" />
      )

      await screen.findByRole('button', { name: /open large preview/i })
      await waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(1))
    })

    it.each([415, 502])(
      'falls back to "no inline preview" and the download on %i',
      async (status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }))
        render(<FilePreviewPane file={docx} projectId="proj-1" />)

        expect(await screen.findByText(/no inline preview/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
        expect(screen.queryByRole('button', { name: /open large preview/i })).toBeNull()
        expect(screen.queryByTestId('file-preview-rendition-note')).toBeNull()
      }
    )

    it('never draws an answer that is not a PDF', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://example.test/raw.docx', contentType: docx.contentType }),
        })
      )
      render(<FilePreviewPane file={docx} projectId="proj-1" />)

      expect(await screen.findByText(/no inline preview/i)).toBeInTheDocument()
      expect(screen.queryByTestId('pdf-scroll')).toBeNull()
      expect(pdf.opened).toEqual([])
    })
  })

  describe('peek presentation', () => {
    const markdownFile = {
      ...mockFile,
      id: 'doc-text',
      filename: 'notiz.md',
      contentType: 'text/markdown',
    }

    /** Tall enough that no 320px side pane shows it whole. */
    const TALL_MARKDOWN = [
      '# Fluchtwege',
      ...Array.from(
        { length: 60 },
        (_, i) => `Absatz ${i + 1}: zwei voneinander unabhängige Fluchtwege je Nutzungseinheit.`
      ),
    ].join('\n\n')

    const mockText = (text: string) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text, truncated: false }),
      } as Response)
    }

    const renderPeekMarkdown = async (text: string) => {
      mockText(text)
      render(<FilePreviewPane file={markdownFile} presentation="peek" />)
      await screen.findByRole('heading', { name: 'Fluchtwege' })
      return screen.getByTestId('file-preview-well')
    }

    it('gives a tall markdown its own vertical scroll instead of clipping it', async () => {
      // The peek body is `overflow-hidden` and the text page only scrolls
      // horizontally, so without a scroll container on the well the rest of a
      // tall document was simply unreachable.
      const well = await renderPeekMarkdown(TALL_MARKDOWN)

      expect(well.classList.contains('overflow-y-auto')).toBe(true)
      expect(well.classList.contains('overflow-hidden')).toBe(false)
      // The same scroll language the peek summary footer speaks.
      expect(well.classList.contains('scroll-fade-bottom')).toBe(true)
    })

    it('keeps a short document centred in the peek well', async () => {
      // Centring is per-child auto margins rather than `items-center`: a
      // centred flex container clips the top of overflowing content
      // unreachably, while auto margins collapse to top-aligned the moment the
      // document outgrows the well.
      const well = await renderPeekMarkdown('# Fluchtwege\n\nKurz.')

      expect(well.classList.contains('justify-center')).toBe(true)
      expect(well.classList.contains('[&>*]:my-auto')).toBe(true)
      expect(well.classList.contains('items-center')).toBe(false)
    })

    it('leaves the modal/stacked well alone', async () => {
      mockText(TALL_MARKDOWN)
      render(<FilePreviewPane file={markdownFile} projectId="proj-1" />)

      await screen.findByRole('heading', { name: 'Fluchtwege' })
      const well = screen.getByTestId('file-preview-well')

      // No bare vertical scroll (the `@2xl:` split-column token is a different
      // class and stays), still clipped to the capped mobile block.
      expect(well.classList.contains('overflow-y-auto')).toBe(false)
      expect(well.classList.contains('overflow-hidden')).toBe(true)
      expect(well.classList.contains('h-[50dvh]')).toBe(true)
    })
  })

  /**
   * An upload finishes while its file is open. The pane is handed a fresher
   * `file` by the host's status poll; everything it shows has to follow
   * without the reader closing and reopening the document.
   */
  describe('while the open document finishes indexing', () => {
    const detailsResponse = (details: unknown[]) =>
      ({ ok: true, json: async () => ({ details }) }) as Response
    const previewResponse = { ok: true, json: async () => ({ url: 'https://example.test/plan.pdf' }) } as Response

    it('asks for the visual descriptions again once the status moves, instead of keeping an early empty answer', async () => {
      let detailsCalls = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes('/visual-details')) {
          detailsCalls += 1
          return detailsCalls === 1
            ? detailsResponse([])
            : detailsResponse([{ page: 2, contentType: 'drawing', text: 'Ein Grundriss.' }])
        }
        return previewResponse
      })
      const reading = { ...mockFile, status: 'processing', contentTypes: ['text', 'drawing'] }
      const { rerender } = render(<FilePreviewPane file={reading} projectId="proj-1" />)

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))
      expect(await screen.findByText('No visual descriptions available.')).toBeInTheDocument()

      rerender(<FilePreviewPane file={{ ...reading, status: 'ready' }} projectId="proj-1" />)

      expect(await screen.findByText('Ein Grundriss.')).toBeInTheDocument()
      expect(screen.queryByText('No visual descriptions available.')).toBeNull()
      expect(detailsCalls).toBe(2)
    })

    it('says a failed read of the descriptions failed, and asks again on retry', async () => {
      let detailsCalls = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes('/visual-details')) {
          detailsCalls += 1
          return detailsCalls === 1
            ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
            : detailsResponse([{ page: 1, contentType: 'drawing', text: 'Ein Schnitt.' }])
        }
        return previewResponse
      })
      render(<FilePreviewPane file={{ ...mockFile, contentTypes: ['drawing'] }} projectId="proj-1" />)

      await userEvent.click(screen.getByRole('button', { name: /detailed information/i }))
      expect(await screen.findByText('The descriptions could not be loaded.')).toBeInTheDocument()
      // Not the same claim as "there are none".
      expect(screen.queryByText('No visual descriptions available.')).toBeNull()

      const details = screen.getByText('The descriptions could not be loaded.').parentElement!
      await userEvent.click(within(details).getByRole('button', { name: 'Try again' }))

      expect(await screen.findByText('Ein Schnitt.')).toBeInTheDocument()
      expect(detailsCalls).toBe(2)
    })

    it('adopts tags that arrive after the file was opened', () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(previewResponse)
      const { rerender } = render(<FilePreviewPane file={{ ...mockFile, tags: null }} projectId="proj-1" />)
      expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()

      rerender(<FilePreviewPane file={{ ...mockFile, tags: ['Brandschutz'] }} projectId="proj-1" />)

      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeInTheDocument()
    })

    it('does not let tags from a read replace a save that is still in flight', async () => {
      let finishSave: (r: Response) => void = () => undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes('/tags')) {
          return new Promise<Response>((resolve) => {
            finishSave = resolve
          })
        }
        return previewResponse
      })
      const { rerender } = render(
        <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }} projectId="proj-1" />
      )
      await userEvent.click(screen.getByRole('button', { name: 'Remove tag Brandschutz' }))

      // A poll that read the row before the save landed.
      rerender(
        <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz', 'Statik'] }} projectId="proj-1" />
      )

      expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()
      finishSave({ ok: true, json: async () => ({}) } as Response)
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove tag Grundriss' })).not.toBeNull())
    })

    it('says the document is still being read instead of an empty "Read by Piloti"', () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(previewResponse)
      render(<FilePreviewPane file={{ ...mockFile, status: 'processing' }} projectId="proj-1" />)

      expect(screen.getByText(/still reading this document/i)).toBeInTheDocument()
      expect(screen.queryByText(/automatically detected on upload/i)).toBeNull()
    })

    it('shows no indexed heading or caption under a failed document', () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(previewResponse)
      render(<FilePreviewPane file={{ ...mockFile, status: 'failed' }} projectId="proj-1" />)

      expect(screen.queryByRole('region', { name: 'Read by Piloti' })).toBeNull()
      expect(screen.queryByText(/still reading this document/i)).toBeNull()
      expect(screen.queryByText(/automatically detected on upload/i)).toBeNull()
    })

    it('replaces the pending line with the summary once it arrives', () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(previewResponse)
      const { rerender } = render(
        <FilePreviewPane file={{ ...mockFile, status: 'processing' }} projectId="proj-1" />
      )
      rerender(
        <FilePreviewPane
          file={{ ...mockFile, status: 'ready', summary: 'Ein Brandschutzkonzept.' }}
          projectId="proj-1"
        />
      )

      expect(screen.getByText('Ein Brandschutzkonzept.')).toBeInTheDocument()
      expect(screen.queryByText(/still reading this document/i)).toBeNull()
      expect(screen.getByText(/automatically detected on upload/i)).toBeInTheDocument()
    })
  })

  /**
   * A rendition takes seconds. Opening another file before it lands must not
   * let the first answer paint document A under document B's name.
   */
  it('never shows a previous document\'s late preview under the next one', async () => {
    const pending = new Map<string, (r: Response) => void>()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const url = String(input)
          pending.set(url, resolve)
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )
    const answer = (url: string) =>
      ({ ok: true, status: 200, json: async () => ({ url }) }) as Response
    // Images, because their element carries the answer's URL verbatim. A PDF
    // is drawn from the same-origin stream of the CURRENT file whatever the
    // answer said, so it could not show a stale answer if the guard broke.
    const image = { ...mockFile, filename: 'a.png', contentType: 'image/png' }

    const { rerender } = render(<FilePreviewPane file={image} projectId="proj-1" />)
    rerender(<FilePreviewPane file={{ ...image, id: 'doc-2', filename: 'b.png' }} projectId="proj-1" />)

    pending.get('/api/documents/doc-2/preview')?.(answer('https://example.test/b.png'))
    await waitFor(() =>
      expect(screen.getByAltText('b.png').getAttribute('src')).toBe('https://example.test/b.png')
    )
    // The first document's answer arrives last.
    pending.get('/api/documents/doc-1/preview')?.(answer('https://example.test/a.png'))
    await new Promise((r) => setTimeout(r, 0))

    expect(screen.getByAltText('b.png').getAttribute('src')).toBe('https://example.test/b.png')
  })
})

describe('FilePreviewPane — a report Piloti wrote', () => {
  const generated = {
    id: 'doc-9',
    filename: 'Tiefenrecherche_Brandschutz.pdf',
    displayName: null,
    fileSize: 1048576,
    contentType: 'application/pdf',
    status: 'stored',
    folderId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    authoredBy: 'agent' as const,
  }

  it('leads the rail with the byline, clear of the assignment row', () => {
    render(<FilePreviewPane file={generated} projectId="proj-1" canCollaborate />)

    const byline = screen.getByText('Created by Piloti')
    expect(byline.tagName).toBe('P')
    // Provenance and responsibility are two answers, and the design forbids
    // reading them as one: the byline is its own line above „Verantwortlich".
    const identity = byline.parentElement
    expect(identity?.firstElementChild).toBe(byline)
    expect(identity?.textContent).toMatch(/Responsible/)
    // The status is the header's, beside the name — never restated here.
    expect(within(identity!).queryByText('Filed')).toBeNull()
    expect(screen.getAllByText('Filed')).toHaveLength(1)
  })

  it('drops the „Von Piloti gelesen" section, which would be a false claim', () => {
    render(<FilePreviewPane file={generated} projectId="proj-1" showMetadataPanel />)

    // The eyebrow describes an ingestion that never ran, and it would sit two
    // lines under a hint saying the report is not in the knowledge base.
    expect(screen.queryByText('Read by Piloti')).not.toBeInTheDocument()
    // The facts that come from the FILE are still there.
    expect(screen.getByText('Size')).toBeInTheDocument()
  })

  it('offers Besprechen and still says the report is not in the knowledge base', async () => {
    // THE POINT OF THE CHANGE. This button used to be greyed out for exactly
    // this document — a report Piloti wrote, deliberately never indexed — which
    // made the one file the reader most wants to talk about the one file they
    // could not. The turn reads an unpublished version's own bytes now, so the
    // control works; what it cannot do is cite the report as Projektwissen, and
    // the hint still says so.
    render(<FilePreviewPane file={generated} projectId="proj-1" />)

    const discuss = screen.getByRole('button', { name: 'Discuss' })
    expect(discuss).toBeEnabled()
    expect(discuss).toHaveAttribute('title', 'Created by Piloti — not in the knowledge base')
  })

  it('withholds Ask on a machine-authored row whose status says citable', () => {
    // The design's own lesson from this feature, which had been written down
    // and not applied: "Every not-citable affordance derived from `status`.
    // That was fine while `stored` implied agent-authored, and wrong the
    // instant anything moved the row out of `stored`. Provenance is the durable
    // fact." The gates read `status` alone until now.
    //
    // Nothing can move an agent row out of `stored` today — `dispatchDocument`
    // refuses it, and `stored` is terminal so the poller never revisits it —
    // which is precisely why this is cheap to fix now and expensive to discover
    // later. `status` says where a document is in a pipeline and can move;
    // `authored_by` says what it is and cannot.
    render(<FilePreviewPane file={{ ...generated, status: 'completed' }} projectId="proj-1" />)

    const discuss = screen.getByRole('button', { name: 'Discuss' })
    expect(discuss).toHaveAttribute('title', 'Created by Piloti — not in the knowledge base')
  })

  it('says nothing extra about a document that is simply still being read', () => {
    // The uploaded file will be Projektwissen in a minute; there is nothing to
    // warn anybody about, so the button carries no hint at all. The never-indexed
    // sentence belongs to the report above and to nothing else.
    render(
      <FilePreviewPane
        file={{ ...generated, status: 'processing', authoredBy: 'user' }}
        projectId="proj-1"
      />
    )

    const discuss = screen.getByRole('button', { name: 'Discuss' })
    expect(discuss).toBeEnabled()
    expect(discuss).not.toHaveAttribute('title')
  })

  describe('text-shaped documents', () => {
    const textFile = (contentType: string, filename: string) => ({
      id: 'doc-text',
      filename,
      displayName: null,
      fileSize: 2048,
      contentType,
      status: 'ready',
      folderId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      errorMessage: null,
      summary: null,
      pageCount: null,
      chunkCount: null,
      contentTypes: null,
      tags: null,
    })

    /**
     * The regression this whole branch exists for: `.md`, `.txt` and `.csv` are
     * accepted at upload and used to draw the same "no inline preview" mock as a
     * format the product genuinely cannot open.
     */
    it('renders a Markdown document instead of the no-preview mock', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text: '# Fluchtwege\n\nZwei je Nutzungseinheit.', truncated: false }),
      } as Response)

      render(<FilePreviewPane file={textFile('text/markdown', 'notiz.md')} projectId="proj-1" />)

      expect(await screen.findByRole('heading', { name: 'Fluchtwege' })).toBeDefined()
      expect(screen.queryByText(/no inline preview/i)).toBeNull()
    })

    it('reads a CSV as a table, sniffing the semicolon a German export uses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          text: 'Bauteil;U-Wert\nAußenwand;0,20\n',
          truncated: false,
        }),
      } as Response)

      render(<FilePreviewPane file={textFile('text/csv', 'katalog.csv')} projectId="proj-1" />)

      // Two cells, not one — a comma-first reader would render the whole row as
      // a single column, which reads as a one-column file rather than a misparse.
      expect(await screen.findByRole('columnheader', { name: 'Bauteil' })).toBeDefined()
      expect(screen.getByRole('columnheader', { name: 'U-Wert' })).toBeDefined()
      expect(screen.getByRole('cell', { name: 'Außenwand' })).toBeDefined()
    })

    it('says so when only the beginning of a file is shown', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text: 'Zeile eins\nZeile zwei', truncated: true }),
      } as Response)

      render(<FilePreviewPane file={textFile('text/plain', 'protokoll.txt')} projectId="proj-1" />)

      // Without this line the last row a reader sees reads as the end of the file.
      expect(await screen.findByText(/only the beginning of this file is shown/i)).toBeDefined()
    })

    it('asks the text route, not the presign route', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ text: 'x', truncated: false }),
      } as Response)

      render(<FilePreviewPane file={textFile('text/plain', 'a.txt')} projectId="proj-1" />)

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
      const asked = fetchSpy.mock.calls.map((call) => String(call[0]))
      expect(asked.some((url) => url.endsWith('/api/documents/doc-text/text'))).toBe(true)
      expect(asked.some((url) => url.endsWith('/preview'))).toBe(false)
    })

    it('offers a retry when the text fetch fails, the same way the URL path does', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response)

      render(<FilePreviewPane file={textFile('text/plain', 'a.txt')} projectId="proj-1" />)

      expect(await screen.findByRole('button', { name: /try again/i })).toBeDefined()
    })
  })
})
