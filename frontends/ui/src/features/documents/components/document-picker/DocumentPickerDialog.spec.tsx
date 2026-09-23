/**
 * The document picker. Pinned: it is the Files browser in a dialog — the same
 * `FileCard`s and detail list, the same read-only folder navigation — with a
 * checkbox on every document. It opens on the project with the caller's
 * choice checked; a click toggles; places and folders move through the
 * listing; a document the caller rules out says why and cannot be checked;
 * confirm hands back the chosen documents in the order they were chosen; a
 * choice taken back entirely can still be confirmed, which is how a list is
 * cleared; a single-choice picker confirms on the click.
 */

import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { folder, libraryDocument } from '@/test-utils/library-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentPickerDialog, type PickerDocument } from './DocumentPickerDialog'

const folders = [folder('f-plans', 'Pläne')]
const documents: PickerDocument[] = [
  libraryDocument('baubeschreibung.pdf', { title: 'Baubeschreibung' }),
  libraryDocument('Grundriss EG.pdf', { folderId: 'f-plans' }),
  libraryDocument('Leitfaden OIB 2.pdf', { shelf: 'archiv' }),
]

const cards = () => screen.getAllByTestId('file-card')
const checks = () => screen.getAllByTestId('file-card-check')
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
  // Every card asks for its page thumbnail; here none exists, so each falls back.
  const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockClear()
  })

  it('shows each document by its real page thumbnail, not a drawn stand-in', async () => {
    renderPicker()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/documents/doc-baubeschreibung.pdf/thumbnail'))
    )
  })

  it('opens on the project as file cards, its folder beside them and the caller’s choice checked', () => {
    renderPicker({ initialSelected: ['Baubeschreibung.pdf'] })
    expect(screen.getByTestId('picker-place-project')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('folder-card-f-plans')).toHaveTextContent('Pläne')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toHaveTextContent('Baubeschreibung')
    expect(checks()[0]).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('picker-summary')).toHaveTextContent('1 document selected')
  })

  it('browses folders read-only: no new folder, no folder menu', async () => {
    renderPicker()
    expect(screen.queryByTestId('folder-actions-f-plans')).toBeNull()
    fireEvent.click(within(screen.getByTestId('folder-card-f-plans')).getAllByRole('button')[0])
    await waitFor(() => expect(cards().map((card) => card.textContent)).toEqual([expect.stringContaining('Grundriss')]))
    fireEvent.click(screen.getByTestId('folder-back'))
    await waitFor(() => expect(cards()[0]).toHaveTextContent('Baubeschreibung'))
  })

  it('hands back what was checked, across places, in the order it was checked', async () => {
    const { onConfirm, onOpenChange } = renderPicker()
    fireEvent.click(screen.getByTestId('picker-place-archiv'))
    await waitFor(() => expect(cards().map((card) => card.textContent)).toEqual([expect.stringContaining('Leitfaden')]))
    fireEvent.click(cards()[0])
    fireEvent.click(screen.getByTestId('picker-place-project'))
    await waitFor(() => expect(cards()[0]).toHaveTextContent('Baubeschreibung'))
    fireEvent.click(checks()[0])
    fireEvent.click(screen.getByTestId('picker-confirm'))
    expect(onConfirm.mock.calls[0][0].map((doc: PickerDocument) => doc.name)).toEqual([
      'Leitfaden OIB 2.pdf',
      'baubeschreibung.pdf',
    ])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says why a document cannot be chosen, and does not check it', () => {
    renderPicker({ disabledReason: (doc) => (doc.name === 'baubeschreibung.pdf' ? 'Already named' : null) })
    expect(screen.getByTestId('file-card-reason')).toHaveTextContent('Already named')
    expect(cards()[0]).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(cards()[0])
    expect(checks()[0]).toHaveAttribute('data-state', 'unchecked')
    expect(checks()[0]).toBeDisabled()
    expect(screen.getByTestId('picker-confirm')).toBeDisabled()
  })

  it('„Selected" lists the choice; taking it all back still confirms, as an empty list', async () => {
    const { onConfirm } = renderPicker({ initialSelected: ['Grundriss EG.pdf'] })
    fireEvent.click(screen.getByTestId('picker-place-selected'))
    await waitFor(() => expect(cards().map((card) => card.textContent)).toEqual([expect.stringContaining('Grundriss')]))
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByTestId('picker-summary')).toHaveTextContent('Nothing selected')
    fireEvent.click(screen.getByTestId('picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith([])
  })

  it('nothing chosen and nothing changed: there is nothing to confirm', () => {
    renderPicker()
    expect(screen.getByTestId('picker-confirm')).toBeDisabled()
  })

  it('shows the detail list with a checkbox column, and a row toggles', async () => {
    renderPicker()
    fireEvent.click(screen.getByTestId('picker-view-list'))
    await waitFor(() => expect(screen.getByTestId('file-list-view')).toBeInTheDocument())
    const row = screen.getAllByTestId('file-list-row')[0]
    fireEvent.click(row)
    expect(within(row).getByTestId('file-list-check')).toHaveAttribute('data-state', 'checked')
  })

  it('choosing one confirms on the click', () => {
    const { onConfirm } = renderPicker({ multiple: false })
    fireEvent.click(cards()[0])
    expect(onConfirm.mock.calls[0][0][0].name).toBe('baubeschreibung.pdf')
  })

  it('offers the caller’s own control beside the summary', () => {
    renderPicker({ footer: <span data-testid="caller-footer">mine</span> })
    expect(screen.getByTestId('caller-footer')).toBeInTheDocument()
  })
})
