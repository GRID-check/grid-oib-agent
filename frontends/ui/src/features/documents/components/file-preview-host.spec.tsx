import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useFilePreviewStore } from '../stores/file-preview-store'
import type { FileItem } from './project-file-workspace'

const pane = vi.hoisted(() => ({ mounts: 0 }))
const nav = vi.hoisted(() => ({ pathname: '/app/projects/p1/files' }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}))

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/use-reduced-motion', () => ({
  useReducedMotion: () => true,
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: (selector: (state: { rightPanel: null }) => unknown) =>
    selector({ rightPanel: null }),
}))

vi.mock('./file-preview-pane', async () => {
  const React = await import('react')
  return {
    FilePreviewPane: function FilePreviewPaneMock() {
      React.useEffect(() => {
        pane.mounts += 1
      }, [])
      return React.createElement('div', { 'data-testid': 'file-preview-pane' })
    },
  }
})

import { FilePreviewBridge, FilePreviewHost } from './file-preview-host'

const FILE: FileItem = {
  id: 'doc-1',
  filename: 'model.ifc',
  displayName: null,
  fileSize: 12,
  contentType: 'application/x-step',
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

describe('FilePreviewHost', () => {
  beforeEach(() => {
    pane.mounts = 0
    nav.pathname = '/app/projects/p1/files'
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekRatio: 38,
      context: {},
    })
  })

  afterEach(() => {
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekRatio: 38,
      context: {},
    })
  })

  it('keeps the pane mounted (parked) when Ask flips to peek while still on Files', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(<FilePreviewHost />)

    expect(screen.getByTestId('file-preview-pane')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(pane.mounts).toBe(1)
  })

  it('does not remount the pane when the chat route lands', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(pane.mounts).toBe(1)
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')

    nav.pathname = '/app/projects/p1/chat'
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(pane.mounts).toBe(1)
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'peek')
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
  })

  it('peeks as a split pane so chat children stay visible', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'peek')
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('still shows the Files modal and unmounts only when the file is closed', () => {
    useFilePreviewStore.getState().open(FILE, 'modal', { projectId: 'p1' })
    const { rerender } = render(<FilePreviewHost />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'modal')

    useFilePreviewStore.getState().close()
    rerender(<FilePreviewHost />)

    expect(screen.queryByTestId('file-preview-host')).not.toBeInTheDocument()
  })

  it('does not show peek chrome on Settings after Ask; the pane stays parked', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    nav.pathname = '/app/projects/p1/settings'
    render(<FilePreviewHost />)

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-preview-pane')).toBeInTheDocument()
  })

  it('hides the split and parks the pane without dropping the file', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    useFilePreviewStore.getState().hide()
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(pane.mounts).toBe(1)
  })

  it('expands on chat as a dialog overlay, not a split', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'expanded', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'expanded')
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })
})
