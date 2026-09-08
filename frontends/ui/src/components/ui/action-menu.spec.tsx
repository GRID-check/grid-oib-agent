/**
 * The kit menu that dropdown and right-click both render.
 *
 * The whole point of this control is that the two triggers cannot drift: the
 * same entry list is what a click on ⋯ and a right-click both show. That is
 * the behaviour under test, not the Radix internals of either primitive.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { ActionMenu, type ActionMenuEntry } from './action-menu'

const ENTRIES: ActionMenuEntry[] = [
  { type: 'item', id: 'open', label: 'Open', onSelect: vi.fn(), testId: 'action-open' },
  { type: 'separator' },
  {
    type: 'item',
    id: 'delete',
    label: 'Delete…',
    variant: 'destructive',
    onSelect: vi.fn(),
    testId: 'action-delete',
  },
]

describe('ActionMenu', () => {
  it('opens the same items from a dropdown trigger and from a right-click', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ActionMenu mode="dropdown" entries={ENTRIES} trigger={<button type="button">More</button>} />,
    )

    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(await screen.findByTestId('action-open')).toHaveTextContent('Open')
    expect(screen.getByTestId('action-delete')).toHaveAttribute('data-variant', 'destructive')

    rerender(
      <ActionMenu mode="context" entries={ENTRIES}>
        <p>Canvas</p>
      </ActionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('Canvas'))
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveAttribute(
      'data-variant',
      'destructive',
    )
  })

  it('renders nothing when a dropdown has nothing to offer', () => {
    const { container } = render(
      <ActionMenu mode="dropdown" entries={[]} trigger={<button type="button">More</button>} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('still renders the canvas when a context menu has nothing to offer', () => {
    render(
      <ActionMenu mode="context" entries={[]}>
        <p>Canvas</p>
      </ActionMenu>,
    )
    expect(screen.getByText('Canvas')).toBeInTheDocument()
  })
})
