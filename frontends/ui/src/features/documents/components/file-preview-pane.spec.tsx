import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('renders the summary, page and chunk counts when present', () => {
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
    expect(screen.getByText('Summary')).toBeDefined()
    expect(screen.getByText('A ground-floor plan of the east wing.')).toBeDefined()
    expect(screen.getByText('Pages')).toBeDefined()
    expect(screen.getByText('4')).toBeDefined()
    expect(screen.getByText('Passages')).toBeDefined()
    expect(screen.getByText('12')).toBeDefined()
  })

  it('hides the summary and count rows when the metadata is absent', () => {
    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
    expect(screen.queryByText('Summary')).toBeNull()
    expect(screen.queryByText('Pages')).toBeNull()
    expect(screen.queryByText('Passages')).toBeNull()
  })

  it('renders ingestion-generated tags as chips when present', () => {
    render(
      <FilePreviewPane
        file={{ ...mockFile, tags: ['Grundriss', 'Brandschutz'] }}
        projectId="proj-1"
      />
    )
    expect(screen.getByText('Tags')).toBeDefined()
    expect(screen.getByText('Grundriss')).toBeDefined()
    expect(screen.getByText('Brandschutz')).toBeDefined()
  })

  it('shows the tags block with a placeholder and edit affordance when there are no tags', () => {
    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
    // The block is now always present (with the flag on) so tags can be added.
    expect(screen.getByText('Tags')).toBeDefined()
    expect(screen.getByText('No tags')).toBeDefined()
    expect(screen.getByRole('button', { name: /edit tags/i })).toBeDefined()
  })

  it('does not offer the tags edit affordance when the flag is off', () => {
    render(<FilePreviewPane file={mockFile} projectId="proj-1" showMetadataPanel={false} />)
    expect(screen.queryByText('Tags')).toBeNull()
    expect(screen.queryByRole('button', { name: /edit tags/i })).toBeNull()
  })

  it('edits tags via the popover: toggle, save, optimistic update, PATCH shape', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

    render(<FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" />)

    await user.click(screen.getByRole('button', { name: /edit tags/i }))

    // Grouped by Dokumenttyp / Fachbereich.
    expect(await screen.findByText('Document type')).toBeDefined()
    expect(screen.getByText('Discipline')).toBeDefined()

    // Toggle a discipline tag on, then save.
    await user.click(screen.getByRole('button', { name: 'Brandschutz', pressed: false }))
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    // Optimistic: the new chip is present immediately.
    await waitFor(() => expect(screen.getByText('Brandschutz')).toBeDefined())

    const tagsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')
    expect(tagsCall).toBeDefined()
    expect(tagsCall![1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse((tagsCall![1] as RequestInit).body as string)).toEqual({
      tags: ['Grundriss', 'Brandschutz'],
    })
  })

  it('notifies the parent with the saved tags after a successful PATCH', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
    const onTagsUpdated = vi.fn()

    render(
      <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" onTagsUpdated={onTagsUpdated} />
    )

    await user.click(screen.getByRole('button', { name: /edit tags/i }))
    await user.click(screen.getByRole('button', { name: 'Brandschutz', pressed: false }))
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() =>
      expect(onTagsUpdated).toHaveBeenCalledWith('doc-1', ['Grundriss', 'Brandschutz'])
    )
  })

  it('does not notify the parent when the PATCH fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const onTagsUpdated = vi.fn()

    render(
      <FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" onTagsUpdated={onTagsUpdated} />
    )

    await user.click(screen.getByRole('button', { name: /edit tags/i }))
    await user.click(screen.getByRole('button', { name: 'Brandschutz', pressed: false }))
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(screen.getByText('Grundriss')).toBeDefined())
    expect(onTagsUpdated).not.toHaveBeenCalled()
  })

  it('reverts the optimistic tag update when the PATCH fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)

    render(<FilePreviewPane file={{ ...mockFile, tags: ['Grundriss'] }} projectId="proj-1" />)

    await user.click(screen.getByRole('button', { name: /edit tags/i }))
    await user.click(screen.getByRole('button', { name: 'Grundriss', pressed: true }))
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    // After the failed save, the original tag is restored and the added-none stays.
    await waitFor(() => expect(screen.getByText('Grundriss')).toBeDefined())
  })

  it('hides tags when the files-metadata-panel flag is off', () => {
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
  })

  it('hides the metadata block when the files-metadata-panel flag is off, keeping status/type/size', () => {
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
    // The flag-gated metadata block is absent…
    expect(screen.queryByText('Summary')).toBeNull()
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
