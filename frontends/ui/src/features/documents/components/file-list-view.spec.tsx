import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileListView } from './file-list-view'
import type { FileItem } from './project-file-workspace'

const doc = (filename: string, overrides: Partial<FileItem> = {}): FileItem => ({
  id: filename,
  filename,
  fileSize: 1_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-01T09:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  ...overrides,
})

const FILES = [
  doc('Plan_10.pdf', { createdAt: '2026-06-03T09:00:00Z', fileSize: 300 }),
  doc('Plan_2.pdf', { createdAt: '2026-06-02T09:00:00Z', fileSize: 20_000 }),
  doc('Plan_1.pdf', { createdAt: '2026-06-01T09:00:00Z', fileSize: 100 }),
]

const renderList = (files = FILES, overrides: Partial<Parameters<typeof FileListView>[0]> = {}) =>
  render(<FileListView files={files} selectedFileId={null} onSelectFile={vi.fn()} {...overrides} />)

const rowNames = (): string[] =>
  screen.getAllByTestId('file-list-row').map((row) => row.querySelector('span[title]')?.textContent ?? '')

describe('FileListView', () => {
  it('shows the newest first without being asked', () => {
    renderList()
    expect(rowNames()).toEqual(['Plan_10.pdf', 'Plan_2.pdf', 'Plan_1.pdf'])
  })

  it('orders drawings the way they are numbered', async () => {
    const user = userEvent.setup()
    renderList()

    await user.click(screen.getByRole('button', { name: /name/i }))
    expect(rowNames()).toEqual(['Plan_1.pdf', 'Plan_2.pdf', 'Plan_10.pdf'])
  })

  it('flips direction when the same column is clicked again', async () => {
    const user = userEvent.setup()
    renderList()

    await user.click(screen.getByRole('button', { name: /size/i }))
    expect(rowNames()).toEqual(['Plan_2.pdf', 'Plan_10.pdf', 'Plan_1.pdf'])

    await user.click(screen.getByRole('button', { name: /size/i }))
    expect(rowNames()).toEqual(['Plan_1.pdf', 'Plan_10.pdf', 'Plan_2.pdf'])
  })

  it('announces which column is sorted and in which direction', async () => {
    const user = userEvent.setup()
    renderList()

    await user.click(screen.getByRole('button', { name: /name/i }))
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'ascending')
    expect(screen.getByRole('columnheader', { name: /size/i })).toHaveAttribute('aria-sort', 'none')
  })

  it('opens a document on click', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()
    renderList(FILES, { onSelectFile })

    await user.click(screen.getAllByTestId('file-list-row')[1])
    expect(onSelectFile).toHaveBeenCalledWith('Plan_2.pdf')
  })

  it('walks the list with the arrow keys and opens with Enter', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()
    renderList(FILES, { onSelectFile })

    const rows = screen.getAllByTestId('file-list-row')
    rows[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])

    await user.keyboard('{Enter}')
    expect(onSelectFile).toHaveBeenCalledWith('Plan_2.pdf')
  })

  it('does not walk past either end of the list', async () => {
    const user = userEvent.setup()
    renderList()

    const rows = screen.getAllByTestId('file-list-row')
    rows[0].focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows[0])
  })

  it('carries only one tab stop, so the list is one step in the page order', () => {
    renderList()
    const rows = screen.getAllByTestId('file-list-row')
    expect(rows[0]).toHaveAttribute('tabindex', '0')
    expect(rows[1]).toHaveAttribute('tabindex', '-1')
  })

  it('marks the open document as selected', () => {
    renderList(FILES, { selectedFileId: 'Plan_2.pdf' })
    const selected = screen.getAllByTestId('file-list-row').filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
  })

  it('shows a document’s status and its summary on the same row', () => {
    renderList([doc('Energieausweis.pdf', { status: 'processing', summary: 'Heizwärmebedarf und Effizienzklasse.' })])

    expect(screen.getByText('Processing')).toBeDefined()
    expect(screen.getByText('Heizwärmebedarf und Effizienzklasse.')).toBeDefined()
  })
})
