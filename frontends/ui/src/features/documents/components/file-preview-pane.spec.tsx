import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilePreviewPane } from './file-preview-pane'

describe('FilePreviewPane', () => {
  const mockFile = {
    id: 'doc-1',
    filename: 'plan.pdf',
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
    expect(screen.getByText(/1\.0 MB/i)).toBeDefined()
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
                { page: 1, contentType: 'drawing', drawingType: 'schnitt', scale: '1:100', text: 'Ein Längsschnitt.' },
              ],
            }),
          } as Response
        }
        return { ok: true, json: async () => ({ url: 'https://example.test/plan.pdf' }) } as Response
      })

      render(
        <FilePreviewPane file={{ ...mockFile, contentTypes: ['text', 'drawing'] }} projectId="proj-1" />
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

    it('renders the HITL caption and the Updated row from real metadata', () => {
      render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
      expect(
        screen.getByText(/Automatically detected on upload — your corrections improve future answers\./)
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
      // …but the pre-existing status/type/size rows stay (never gated).
      expect(screen.getByText('Status')).toBeDefined()
      expect(screen.getByText('Type')).toBeDefined()
      expect(screen.getByText('Size')).toBeDefined()
      expect(screen.getByText(/1\.0 MB/i)).toBeDefined()
    })

    it('shows content types only when the document holds more than plain text', () => {
      const { rerender } = render(
        <FilePreviewPane file={{ ...mockFile, contentTypes: ['text'] }} projectId="proj-1" />
      )
      // Text-only → no redundant contents row.
      expect(screen.queryByText('Contents')).toBeNull()

      rerender(
        <FilePreviewPane file={{ ...mockFile, contentTypes: ['text', 'table'] }} projectId="proj-1" />
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
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

      // Optimistic: the new chip is present immediately.
      await waitFor(() => expect(screen.getByText('Brandschutz')).toBeDefined())

      const tagsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')
      expect(tagsCall).toBeDefined()
      expect(tagsCall![1]).toMatchObject({ method: 'PATCH' })
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({
        tags: ['Grundriss', 'Brandschutz'],
      })
    })

    it('offers vocabulary suggestions while typing and adds one on click', async () => {
      const user = userEvent.setup()
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: [] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'schall')
      await user.click(await screen.findByRole('button', { name: 'Schallschutz' }))

      await waitFor(() => expect(screen.getByText('Schallschutz')).toBeDefined())
      const tagsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({ tags: ['Schallschutz'] })
    })

    it('does not add free-form values outside the controlled vocabulary', async () => {
      const user = userEvent.setup()
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(<FilePreviewPane file={{ ...mockFile, tags: [] }} projectId="proj-1" />)

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'made-up-tag{Enter}')

      expect(screen.getByText(/no matching tag/i)).toBeDefined()
      const tagsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')
      expect(tagsCall).toBeUndefined()
    })

    it('removes a tag via its × affordance and PATCHes the remainder', async () => {
      const user = userEvent.setup()
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

      render(
        <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }} projectId="proj-1" />
      )

      await user.click(screen.getByRole('button', { name: 'Remove tag Brandschutz' }))

      await waitFor(() => expect(screen.queryByText('Brandschutz')).toBeNull())
      const tagsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')
      expect(tagsCall![1]).toMatchObject({ method: 'PATCH' })
      expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({ tags: ['Grundriss'] })
    })

    it('notifies the parent with the saved tags after a successful PATCH', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
      const onTagsUpdated = vi.fn()

      render(
        <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" onTagsUpdated={onTagsUpdated} />
      )

      await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

      await waitFor(() =>
        expect(onTagsUpdated).toHaveBeenCalledWith('doc-1', ['Grundriss', 'Brandschutz'])
      )
    })

    it('does not notify the parent and reverts the optimistic chip when the PATCH fails', async () => {
      const user = userEvent.setup()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
      const onTagsUpdated = vi.fn()

      render(
        <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" onTagsUpdated={onTagsUpdated} />
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
})
