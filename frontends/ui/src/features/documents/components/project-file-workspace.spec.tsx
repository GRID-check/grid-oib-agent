import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectFileWorkspace } from './project-file-workspace'

const mockUploadFiles = vi.fn()

vi.mock('../hooks/use-project-documents', () => ({
  useProjectDocuments: vi.fn().mockImplementation(() => ({
    uploadFiles: mockUploadFiles,
    retryFile: vi.fn(),
    isUploading: false,
    trackedFiles: [],
    error: null,
    clearError: vi.fn(),
  })),
}))

// useFileDragDrop reads accepted MIME types from AppConfig for its drag affordance.
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

/** Minimal DataTransfer stand-in for jsdom drag events. */
function makeDataTransfer(files: File[]) {
  return {
    items: files.map((f) => ({ kind: 'file', type: f.type })),
    files,
    types: ['Files'],
  }
}

describe('ProjectFileWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the file workspace with its project name and corpus context', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(screen.getByText('Test')).toBeDefined()
    expect(screen.getByText(/ground Grid’s answers/i)).toBeDefined()
  })

  it('shows the drop overlay on dragover of a supported file', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const dataTransfer = makeDataTransfer([
      new File(['x'], 'plan.pdf', { type: 'application/pdf' }),
    ])

    fireEvent.dragEnter(dropzone, { dataTransfer })

    expect(screen.getByTestId('workspace-drop-overlay')).toBeInTheDocument()
    expect(screen.getByText(/drop files to upload/i)).toBeInTheDocument()
  })

  it('routes a dropped file into the existing upload path (uploadFiles)', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const file = new File(['x'], 'plan.pdf', { type: 'application/pdf' })
    const dataTransfer = makeDataTransfer([file])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    fireEvent.drop(dropzone, { dataTransfer })

    expect(mockUploadFiles).toHaveBeenCalledTimes(1)
    expect(mockUploadFiles).toHaveBeenCalledWith([file])
    // Overlay clears after drop.
    expect(screen.queryByTestId('workspace-drop-overlay')).not.toBeInTheDocument()
  })

  it('flags an unsupported drag but still defers rejection to uploadFiles, like the button', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const badFile = new File(['x'], 'photo.png', { type: 'image/png' })
    const dataTransfer = makeDataTransfer([badFile])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    // Unsupported affordance is shown during drag.
    expect(screen.getByText(/not a supported type/i)).toBeInTheDocument()

    fireEvent.drop(dropzone, { dataTransfer })
    // Same contract as the button: files still flow to uploadFiles, which validates.
    expect(mockUploadFiles).toHaveBeenCalledWith([badFile])
  })
})
