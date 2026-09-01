import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilePreviewPane } from './file-preview-pane'

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

  it('offers an expand affordance for a PDF once its preview URL has loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.test/plan.pdf' }),
    } as Response)

    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)

    expect(await screen.findByRole('button', { name: /open large preview/i })).toBeDefined()
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

  describe('"Indexed by Piloti" panel', () => {
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
      expect(screen.getByText('Indexed by Piloti')).toBeDefined()
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

    it('shows the detected document type and project rows only from real metadata', () => {
      render(
        <FilePreviewPane
          file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
          projectId="proj-1"
          projectName="Stadthaus Linz"
        />
      )
      expect(screen.getByText('Document type')).toBeDefined()
      // 'Grundriss' appears both as the Type value and as a tag chip.
      expect(screen.getAllByText('Grundriss').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('Project')).toBeDefined()
      expect(screen.getByText('Stadthaus Linz')).toBeDefined()
    })

    it('omits the document-type and project rows without the metadata', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(screen.queryByText('Document type')).toBeNull()
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
      expect(screen.queryByText('Indexed by Piloti')).toBeNull()
      expect(screen.queryByText('A ground-floor plan of the east wing.')).toBeNull()
      expect(screen.queryByText('Pages')).toBeNull()
      expect(screen.queryByText('Passages')).toBeNull()
      expect(screen.queryByText('Contents')).toBeNull()
      // …but the ungated rows stay. Status is no longer one of them: it moved
      // to the header beside the filename, because "is this actually indexed"
      // is the first question on opening a file and it used to sit below the
      // fold in a column the flag can hide entirely. Assert it is still
      // ANSWERED, just not from a row.
      expect(screen.getByText('Citable')).toBeDefined()
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

  it('surfaces the failure reason and a retry-ingestion affordance for failed documents', () => {
    render(
      <FilePreviewPane
        file={{ ...mockFile, status: 'failed', errorMessage: 'Ingestion could not be started' }}
        projectId="proj-1"
      />
    )
    expect(screen.getByText('Ingestion failed')).toBeDefined()
    expect(screen.getByText('Ingestion could not be started')).toBeDefined()
    expect(screen.getByRole('button', { name: /retry ingestion/i })).toBeDefined()
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

  it('enables Ask when ingest reconciled to completed, not only the literal ready', () => {
    render(<FilePreviewPane file={{ ...mockFile, status: 'completed' }} projectId="proj-1" />)
    const ask = screen.getByRole('button', { name: /ask piloti/i })
    expect(ask).toBeEnabled()
  })

  it('keeps Ask disabled while the file is still being read', () => {
    render(<FilePreviewPane file={{ ...mockFile, status: 'processing' }} projectId="proj-1" />)
    expect(screen.getByRole('button', { name: /ask piloti/i })).toBeDisabled()
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

  it('carries the byline above the type line, clear of the assignment row', () => {
    render(<FilePreviewPane file={generated} projectId="proj-1" canCollaborate />)

    const byline = screen.getByText('Created by Piloti')
    expect(byline.tagName).toBe('P')
    // Provenance and responsibility are two answers, and the design forbids
    // reading them as one: the byline sits under the NAME, with the type ·
    // status line between it and the faces.
    const identity = byline.parentElement
    expect(identity?.querySelector('h3')?.textContent).toBe('Tiefenrecherche_Brandschutz.pdf')
    expect(byline.nextElementSibling?.textContent).toMatch(/PDF/)
  })

  it('drops the „Von Piloti indexiert" section, which would be a false claim', () => {
    render(<FilePreviewPane file={generated} projectId="proj-1" showMetadataPanel />)

    // The eyebrow describes an ingestion that never ran, and it would sit two
    // lines under a hint saying the report is not in the knowledge base.
    expect(screen.queryByText('Indexed by Piloti')).not.toBeInTheDocument()
    // The facts that come from the FILE are still there.
    expect(screen.getByText('Size')).toBeInTheDocument()
  })

  it('disables Ask and says why, instead of promising a wait that never ends', async () => {
    render(<FilePreviewPane file={generated} projectId="proj-1" />)

    const ask = screen.getByRole('button', { name: 'Ask Piloti' })
    expect(ask).toBeDisabled()
    // NOT "Once the file is citable": the report was deliberately never
    // indexed, so there is no "once".
    //
    // And the reason is on the WRAPPER, not the button: a disabled `<button>`
    // dispatches no pointer events in Chrome or Safari, so a `title` on it is a
    // tooltip that can never open. The description is also announced, so the
    // sentence exists for a reader who is not hovering anything.
    expect(ask.closest('[title]')).toHaveAttribute(
      'title',
      'Created by Piloti — not in the knowledge base'
    )
    expect(ask).toHaveAccessibleDescription('Created by Piloti — not in the knowledge base')
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

    const ask = screen.getByRole('button', { name: 'Ask Piloti' })
    expect(ask).toBeDisabled()
    expect(ask.closest('[title]')).toHaveAttribute(
      'title',
      'Created by Piloti — not in the knowledge base'
    )
  })

  it('still promises the wait for a document that really is being read', () => {
    render(
      <FilePreviewPane
        file={{ ...generated, status: 'processing', authoredBy: 'user' }}
        projectId="proj-1"
      />
    )

    const ask = screen.getByRole('button', { name: 'Ask Piloti' })
    expect(ask).toBeDisabled()
    expect(ask.closest('[title]')).toHaveAttribute('title', 'Once the file is citable')
    expect(ask).toHaveAccessibleDescription('Once the file is citable')
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
