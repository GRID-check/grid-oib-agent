import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { FileFilterMenu } from './file-filter-menu'
import { NO_FILE_FILTERS, type FileFilters } from '../lib/file-filters'
import { DEFAULT_FILE_SORT, type FileSort } from '../lib/file-sort'

const renderMenu = (overrides: Partial<Parameters<typeof FileFilterMenu>[0]> = {}) => {
  const onFiltersChange = vi.fn<(next: FileFilters) => void>()
  const onSortChange = vi.fn<(next: FileSort) => void>()
  render(
    <FileFilterMenu
      canCollaborate
      filters={NO_FILE_FILTERS}
      onFiltersChange={onFiltersChange}
      sort={DEFAULT_FILE_SORT}
      onSortChange={onSortChange}
      {...overrides}
    />
  )
  return { onFiltersChange, onSortChange }
}

const open = () => userEvent.click(screen.getByTestId('file-filter-menu-trigger'))

/**
 * The strip these tests replaced showed its state by looking pressed. A popover
 * cannot, so the count on the trigger carries it instead — which makes the
 * badge load-bearing rather than decoration, and is why it is tested first.
 */
describe('FileFilterMenu', () => {
  test('shows no count while nothing is filtered', () => {
    renderMenu()
    expect(screen.queryByTestId('file-filter-count')).not.toBeInTheDocument()
  })

  test('puts the count in the accessible name, not only in the pill', async () => {
    renderMenu({ filters: { ...NO_FILE_FILTERS, assignment: 'mine', kinds: ['photo'] } })
    expect(screen.getByTestId('file-filter-count')).toHaveTextContent('2')
    // A badge a screen reader never reads is a state change nobody announced.
    expect(screen.getByTestId('file-filter-menu-trigger')).toHaveAccessibleName(/2/)
  })

  test('does not count assignment when the section is not offered', () => {
    renderMenu({ canCollaborate: false, filters: { ...NO_FILE_FILTERS, assignment: 'mine' } })
    expect(screen.queryByTestId('file-filter-count')).not.toBeInTheDocument()
  })

  test('hides the assignment section when collaboration is off', async () => {
    renderMenu({ canCollaborate: false })
    await open()
    expect(screen.queryByRole('group', { name: 'Responsible' })).not.toBeInTheDocument()
    // The rest still renders: authorship and type exist whether or not a
    // project assigns work.
    expect(await screen.findByLabelText('By Piloti')).toBeInTheDocument()
  })

  test('toggles a kind without disturbing the other dimensions', async () => {
    const { onFiltersChange } = renderMenu({
      filters: { ...NO_FILE_FILTERS, assignment: 'mine', statuses: ['failed'] },
    })
    await open()
    await userEvent.click(await screen.findByLabelText('3D model (IFC)'))
    expect(onFiltersChange).toHaveBeenCalledWith({
      assignment: 'mine',
      agentAuthoredOnly: false,
      statuses: ['failed'],
      kinds: ['model'],
    })
  })

  /**
   * A new column takes its OWN default direction. Inheriting the previous
   * column's gives "Name, descending" the moment you arrive from "Hinzugefügt",
   * which is Z→A and not what anyone means by sorting a list of drawings.
   */
  test('a new sort column takes its own default direction', async () => {
    const { onSortChange } = renderMenu({ sort: { key: 'added', direction: 'desc' } })
    await open()
    await userEvent.click(await screen.findByRole('radio', { name: 'Name' }))
    expect(onSortChange).toHaveBeenCalledWith({ key: 'name', direction: 'asc' })
  })

  test('flips the direction without changing the column', async () => {
    const { onSortChange } = renderMenu({ sort: { key: 'size', direction: 'desc' } })
    await open()
    await userEvent.click(await screen.findByTestId('file-filter-direction'))
    expect(onSortChange).toHaveBeenCalledWith({ key: 'size', direction: 'asc' })
  })

  /**
   * A ranked result set orders itself, and re-sorting it by upload date throws
   * the ranking away without saying so. Hidden rather than disabled: there is
   * nothing the reader could press to enable it short of clearing a search they
   * meant to run.
   */
  test('offers no ordering while a semantic search is active', async () => {
    renderMenu({ sortDisabled: true })
    await open()
    expect(await screen.findByLabelText('Photo')).toBeInTheDocument()
    expect(screen.queryByTestId('file-filter-direction')).not.toBeInTheDocument()
  })

  test('reset is offered but inert while nothing is filtered', async () => {
    const { onFiltersChange } = renderMenu()
    await open()
    // Disabled, not hidden — a control that appears on the first click moves
    // everything under the cursor.
    expect(await screen.findByTestId('file-filter-reset')).toBeDisabled()
    expect(onFiltersChange).not.toHaveBeenCalled()
  })

  test('reset clears every dimension at once, the server-side one included', async () => {
    const { onFiltersChange } = renderMenu({
      filters: { assignment: 'unassigned', agentAuthoredOnly: true, kinds: ['photo'], statuses: ['ready'] },
    })
    await open()
    await userEvent.click(await screen.findByTestId('file-filter-reset'))
    expect(onFiltersChange).toHaveBeenCalledWith(NO_FILE_FILTERS)
  })
})
