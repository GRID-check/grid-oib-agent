import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectFileWorkspace } from './project-file-workspace'

vi.mock('../hooks/use-project-documents', () => ({
  useProjectDocuments: vi.fn().mockReturnValue({
    uploadFiles: vi.fn(),
    retryFile: vi.fn(),
    isUploading: false,
    trackedFiles: [],
    error: null,
    clearError: vi.fn(),
  }),
}))

describe('ProjectFileWorkspace', () => {
  it('renders the file workspace with its project name and corpus context', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(screen.getByText('Test')).toBeDefined()
    expect(screen.getByText(/ground Grid’s answers/i)).toBeDefined()
  })
})
