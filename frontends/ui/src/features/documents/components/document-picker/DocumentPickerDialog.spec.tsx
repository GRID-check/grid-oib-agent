/**
 * The document picker. Pinned: it opens on the project with the caller's
 * choice marked; a click marks, a double click opens a folder; the path and
 * back/forward move through places; a document the caller rules out says why
 * and cannot be marked; confirm hands back the chosen documents in the order
 * they were chosen; a single-choice picker confirms on a double click.
 */

import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { DocumentPickerDialog, type PickerDocument } from './DocumentPickerDialog'

const folders: FolderItem[] = [{ id: 'f-plans', parentId: null, name: 'Pläne', path: '/Pläne' }]
const file = (folderId: string | null) => ({
  folderId,
  createdAt: '2026-09-01T00:00:00Z',
  fileSize: 2048,
  contentType: 'application/pdf',
  pageCount: 4,
  summary: null,
  tags: null,
})
const documents: PickerDocument[] = [
  { name: 'baubeschreibung.pdf', title: 'Baubeschreibung', shelf: 'project', file: file(null) },
  { name: 'Grundriss EG.pdf', shelf: 'project', file: file('f-plans') },
  { name: 'Leitfaden OIB 2.pdf', shelf: 'archiv', file: file(null) },
]

const docs = () => screen.getAllByTestId('picker-doc')
const renderPicker = (props: Partial<Parameters<typeof DocumentPickerDialog>[0]> = {}) => {
  const onConfirm = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <DocumentPickerDialog
      open
      onOpenChange={onOpenChange}
      title="Choose"
      documents={documents}
      folders={folders}
      confirmLabel="Apply"
      onConfirm={onConfirm}
      {...props}
    />
  )
  return { onConfirm, onOpenChange }
}

describe('DocumentPickerDialog', () => {
  it('opens on the project, with folders first and the caller’s choice marked', () => {
    renderPicker({ initialSelected: ['Baubeschreibung.pdf'] })
    expect(screen.getByTestId('picker-path')).toHaveTextContent('Project')
    expect(screen.getAllByTestId('picker-folder')[0]).toHaveTextContent('Pläne')
    expect(docs()[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('picker-summary')).toHaveTextContent('1 document selected')
  })

  // A place's content slides out while the next slides in, so each step waits for the exit.
  it('opens a folder on a double click, and back and the path return', async () => {
    renderPicker()
    fireEvent.doubleClick(screen.getByTestId('picker-folder'))
    expect(screen.getByTestId('picker-path')).toHaveTextContent('Pläne')
    await waitFor(() => expect(docs()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('picker-back'))
    expect(screen.getByTestId('picker-path')).not.toHaveTextContent('Pläne')
    fireEvent.click(screen.getByTestId('picker-forward'))
    fireEvent.click(within(screen.getByTestId('picker-path')).getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(screen.getAllByTestId('picker-folder')).toHaveLength(1))
  })

  it('hands back what was marked, across places, in the order it was marked', async () => {
    const { onConfirm, onOpenChange } = renderPicker()
    fireEvent.click(screen.getByTestId('picker-place-archiv'))
    await waitFor(() => expect(docs().map((row) => row.textContent)).toEqual([expect.stringContaining('Leitfaden')]))
    fireEvent.click(docs()[0])
    fireEvent.click(screen.getByTestId('picker-place-project'))
    await waitFor(() => expect(docs().map((row) => row.textContent)).toEqual([expect.stringContaining('Baubeschreibung')]))
    fireEvent.click(docs()[0])
    fireEvent.click(screen.getByTestId('picker-confirm'))
    expect(onConfirm.mock.calls[0][0].map((doc: PickerDocument) => doc.name)).toEqual([
      'Leitfaden OIB 2.pdf',
      'baubeschreibung.pdf',
    ])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says why a document cannot be chosen, and does not mark it', () => {
    renderPicker({ disabledReason: (doc) => (doc.name === 'baubeschreibung.pdf' ? 'Already named' : null) })
    expect(docs()[0]).toHaveTextContent('Already named')
    fireEvent.click(docs()[0])
    expect(docs()[0]).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('picker-confirm')).toBeDisabled()
  })

  it('searches through the place, and „Selected" shows the choice', async () => {
    renderPicker()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), { target: { value: 'grundriss' } })
    expect(docs()).toHaveLength(1)
    fireEvent.click(docs()[0])
    fireEvent.click(screen.getByTestId('picker-place-selected'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), { target: { value: '' } })
    await waitFor(() => expect(docs()).toHaveLength(1))
    expect(docs()[0]).toHaveTextContent('Grundriss EG.pdf')
  })

  it('switches to icons, and previews the document in focus with a toggle of its own', async () => {
    renderPicker()
    fireEvent.click(docs()[0])
    const preview = screen.getByTestId('picker-preview')
    expect(preview).toHaveTextContent('Baubeschreibung')
    expect(preview).toHaveTextContent('4')
    // The preview's button says the document is chosen, and unchooses it.
    expect(within(preview).getByTestId('picker-preview-toggle')).toHaveTextContent('Selected')
    fireEvent.click(within(preview).getByTestId('picker-preview-toggle'))
    expect(docs()[0]).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByTestId('picker-view-grid'))
    expect(screen.getByTestId('picker-view-grid')).toHaveAttribute('data-state', 'on')
    await waitFor(() => expect(docs()).toHaveLength(1))
  })

  it('shows the shape of the listing while it loads, not an empty folder', () => {
    renderPicker({ documents: [], folders: [], loading: true })
    expect(screen.getByTestId('picker-skeleton')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('folds a deep path into its ends, and „…" steps up one level', async () => {
    const deep: FolderItem[] = [
      { id: 'a', parentId: null, name: 'A', path: '/A' },
      { id: 'b', parentId: 'a', name: 'B', path: '/A/B' },
      { id: 'c', parentId: 'b', name: 'C', path: '/A/B/C' },
    ]
    renderPicker({ folders: deep, documents: [{ name: 'x.pdf', shelf: 'project', file: file('c') }] })
    for (const name of ['A', 'B', 'C']) {
      await waitFor(() => expect(screen.getByTestId('picker-folder')).toHaveTextContent(name))
      fireEvent.doubleClick(screen.getByTestId('picker-folder'))
    }
    const path = screen.getByTestId('picker-path')
    await waitFor(() => expect(path).toHaveTextContent(/Project.*….*C/))
    expect(path).not.toHaveTextContent('B')
    fireEvent.click(within(path).getByRole('button', { name: '…' }))
    expect(screen.getByTestId('picker-path')).toHaveTextContent(/Project.*A.*B/)
  })

  it('choosing one confirms on a double click', () => {
    const { onConfirm } = renderPicker({ multiple: false })
    fireEvent.doubleClick(docs()[0])
    expect(onConfirm.mock.calls[0][0][0].name).toBe('baubeschreibung.pdf')
  })

  it('walks with the keyboard: arrows move, space marks, Enter confirms', () => {
    const { onConfirm } = renderPicker()
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onConfirm.mock.calls[0][0][0].name).toBe('baubeschreibung.pdf')
  })
})
