import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('does not offer the expand affordance for a non-PDF file', async () => {
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

    // Wait for the preview fetch to settle, then confirm no expand button exists.
    await waitFor(() => expect(screen.getByAltText('diagram.png')).toBeDefined())
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
