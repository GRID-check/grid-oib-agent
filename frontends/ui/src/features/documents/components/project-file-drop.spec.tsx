import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'
import { ProjectFileDrop, routesDropToFiles } from './project-file-drop'
import { takeDroppedFiles } from '../lib/dropped-file-handover'

const nav = vi.hoisted(() => ({ pathname: '/app/projects/p1/settings', push: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}))

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    fileUpload: {
      acceptedTypes: '.pdf',
      acceptedMimeTypes: ['application/pdf'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

const plan = new File(['%PDF'], 'Grundriss.pdf', { type: 'application/pdf' })

/** A drag from the desktop: `Files` in `types` is what marks it as an upload. */
function fileTransfer(files: File[]) {
  return { types: ['Files'], files, items: [] }
}

describe('routesDropToFiles', () => {
  it('takes a drop on a project page with no drop target of its own', () => {
    expect(routesDropToFiles('/app/projects/p1/settings', 'p1')).toBe(true)
    expect(routesDropToFiles('/app/projects/p1/automation/tasks', 'p1')).toBe(true)
  })

  it('leaves the sections that answer a drop themselves', () => {
    for (const section of ['chat', 'files', 'intake', 'research']) {
      expect(routesDropToFiles(`/app/projects/p1/${section}`, 'p1')).toBe(false)
    }
  })

  it('leaves a path outside this project', () => {
    expect(routesDropToFiles('/app/projects/p2/settings', 'p1')).toBe(false)
  })
})

describe('ProjectFileDrop', () => {
  beforeEach(() => {
    nav.push.mockClear()
    nav.pathname = '/app/projects/p1/settings'
    takeDroppedFiles('p1')
  })

  it('hands a file dropped on Einstellungen to Dateien and opens it', async () => {
    render(
      <ProjectFileDrop projectId="p1">
        <p>Einstellungen</p>
      </ProjectFileDrop>
    )

    fireEvent.drop(screen.getByText('Einstellungen'), { dataTransfer: fileTransfer([plan]) })

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/app/projects/p1/files'))
    expect(takeDroppedFiles('p1')).toEqual([plan])
    expect(takeDroppedFiles('p1')).toEqual([])
  })

  it('keeps an earlier drop when a second one lands before Dateien has taken it', async () => {
    const second = new File(['%PDF'], 'Schnitt.pdf', { type: 'application/pdf' })
    render(
      <ProjectFileDrop projectId="p1">
        <p>Einstellungen</p>
      </ProjectFileDrop>
    )

    fireEvent.drop(screen.getByText('Einstellungen'), { dataTransfer: fileTransfer([plan]) })
    fireEvent.drop(screen.getByText('Einstellungen'), { dataTransfer: fileTransfer([second]) })

    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(2))
    expect(takeDroppedFiles('p1')).toEqual([plan, second])
  })

  it('shows where the drop goes while a file is held over the page', () => {
    render(
      <ProjectFileDrop projectId="p1">
        <p>Einstellungen</p>
      </ProjectFileDrop>
    )

    fireEvent.dragEnter(screen.getByText('Einstellungen'), { dataTransfer: fileTransfer([plan]) })

    expect(screen.getByTestId('project-drop-overlay')).toBeInTheDocument()
  })

  it('leaves the chat its own drop', async () => {
    nav.pathname = '/app/projects/p1/chat'
    render(
      <ProjectFileDrop projectId="p1">
        <p>Chat</p>
      </ProjectFileDrop>
    )

    fireEvent.drop(screen.getByText('Chat'), { dataTransfer: fileTransfer([plan]) })

    await Promise.resolve()
    expect(nav.push).not.toHaveBeenCalled()
    expect(takeDroppedFiles('p1')).toEqual([])
  })
})
