/**
 * "Im Blick" is one of the three signals a mount must produce, so the tests
 * that matter are about what it refuses to do: hide the remove control behind a
 * hover, nest that control inside the chip's own button, or render an empty
 * band when nothing is in view.
 */

import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MountedProjectsRow } from './MountedProjectsRow'

const mounted = [
  { projectId: 'a', projectName: 'Seestadt Nord' },
  { projectId: 'b', projectName: 'Rosenhügel' },
]

it('renders nothing at zero mounts', () => {
  const { container } = render(<MountedProjectsRow mounted={[]} onUnmount={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
})

describe('with projects in view', () => {
  it('names every one of them, and says so in the accessible name too', () => {
    render(<MountedProjectsRow mounted={mounted} onUnmount={vi.fn()} />)
    expect(screen.getByText('Seestadt Nord')).toBeInTheDocument()
    expect(screen.getByText('Rosenhügel')).toBeInTheDocument()
    expect(screen.getByLabelText(/Seestadt Nord, Rosenhügel/)).toBeInTheDocument()
  })

  it('offers the remove control without a hover, and removes by id', async () => {
    const onUnmount = vi.fn()
    render(<MountedProjectsRow mounted={mounted} onUnmount={onUnmount} />)

    const remove = screen.getByRole('button', { name: /Remove Seestadt Nord/ })
    await userEvent.click(remove)

    expect(onUnmount).toHaveBeenCalledWith('a')
  })

  it('keeps the × a SIBLING of the chip label, never a control inside a control', () => {
    render(<MountedProjectsRow mounted={mounted} onUnmount={vi.fn()} />)
    const chip = screen.getAllByTestId('mounted-project-chip')[0]!
    // The chip itself is not a button, so the remove control cannot be nested
    // in one; both live side by side inside the bordered wrapper.
    expect(chip.tagName).toBe('SPAN')
    expect(within(chip).getAllByRole('button')).toHaveLength(1)
  })

  it('dims a chip whose removal is in flight rather than dropping it (no layout shift)', () => {
    render(<MountedProjectsRow mounted={mounted} onUnmount={vi.fn()} removing={['a']} />)
    const chips = screen.getAllByTestId('mounted-project-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.className).toContain('opacity-60')
    expect(screen.getByRole('button', { name: /Remove Seestadt Nord/ })).toBeDisabled()
  })
})
