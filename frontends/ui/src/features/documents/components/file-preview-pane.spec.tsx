import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  }

  it('renders file metadata', () => {
    render(<FilePreviewPane file={mockFile} projectId="proj-1" />)
    expect(screen.getByText('plan.pdf')).toBeDefined()
    expect(screen.getByText(/1\.0 MB/i)).toBeDefined()
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
