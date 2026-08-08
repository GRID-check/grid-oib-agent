import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DataToolbar } from './data-toolbar'

const base = {
  searchValue: '',
  onSearchChange: vi.fn(),
  searchPlaceholder: 'Filter documents…',
  searchLabel: 'Filter documents',
  clearLabel: 'Clear filter',
}

describe('DataToolbar', () => {
  test('searches through the controlled value', async () => {
    const onSearchChange = vi.fn()
    render(<DataToolbar {...base} onSearchChange={onSearchChange} />)

    await userEvent.type(screen.getByLabelText('Filter documents'), 'oib')
    expect(onSearchChange).toHaveBeenCalled()
  })

  test('offers a clear affordance only once there is something to clear', async () => {
    const onSearchChange = vi.fn()
    const { rerender } = render(<DataToolbar {...base} onSearchChange={onSearchChange} />)
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()

    rerender(<DataToolbar {...base} searchValue="oib" onSearchChange={onSearchChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  test('swaps to the selection bar once rows are selected', () => {
    // Filtering and acting on a selection are different jobs; showing both
    // invites acting on rows the filter has since hidden.
    render(
      <DataToolbar
        {...base}
        selectedCount={3}
        selectionLabel={(count) => `${count} selected`}
        selectionActions={<button type="button">Reclassify</button>}
        onClearSelection={vi.fn()}
        clearSelectionLabel="Clear"
      />,
    )

    expect(screen.getByTestId('data-toolbar-selection')).toBeDefined()
    expect(screen.queryByTestId('data-toolbar')).toBeNull()
    expect(screen.getByText('3 selected')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reclassify' })).toBeDefined()
    expect(screen.queryByLabelText('Filter documents')).toBeNull()
  })

  test('clears the selection through the callback', async () => {
    const onClearSelection = vi.fn()
    render(
      <DataToolbar
        {...base}
        selectedCount={2}
        selectionLabel={(count) => `${count} selected`}
        onClearSelection={onClearSelection}
        clearSelectionLabel="Clear"
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /Clear/i }))
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  test('stays in filter mode without a selection label, however many rows are selected', () => {
    // The selection bar needs copy; without it, falling into that branch would
    // render an unlabelled bar with no way back.
    render(<DataToolbar {...base} selectedCount={5} />)
    expect(screen.getByTestId('data-toolbar')).toBeDefined()
  })
})
