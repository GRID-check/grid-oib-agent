import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileFilterStrip } from './file-filter-strip'

const renderStrip = (overrides: Partial<Parameters<typeof FileFilterStrip>[0]> = {}) => {
  const props = {
    canCollaborate: true,
    assignmentFilter: 'all' as const,
    onAssignmentFilterChange: vi.fn(),
    agentAuthoredOnly: false,
    onAgentAuthoredOnlyChange: vi.fn(),
    ...overrides,
  }
  render(<FileFilterStrip {...props} />)
  return props
}

describe('FileFilterStrip', () => {
  it('offers Von Piloti beside the assignment filters', () => {
    renderStrip()
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Unassigned' })).toBeInTheDocument()
    expect(screen.getByTestId('filter-agent-authored')).toHaveTextContent('By Piloti')
  })

  it('keeps authorship askable when the project does not assign work', () => {
    // Authorship is not a collaboration feature: a project with the flag off
    // still needs to find what Piloti wrote.
    renderStrip({ canCollaborate: false })
    expect(screen.queryByRole('radio', { name: 'All' })).toBeNull()
    expect(screen.getByTestId('filter-agent-authored')).toBeInTheDocument()
  })

  it('is a filter of its own, so it ANDs with the assignment one', async () => {
    // The lead looking for reports nobody has taken on needs Unvergeben AND Von
    // Piloti at once — which a fourth segment in the exclusive group could not
    // express. Pressing the chip must not disturb the assignment selection.
    const props = renderStrip({ assignmentFilter: 'unassigned' })
    await userEvent.click(screen.getByTestId('filter-agent-authored'))
    expect(props.onAgentAuthoredOnlyChange).toHaveBeenCalledWith(true)
    expect(props.onAssignmentFilterChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'Unassigned' })).toHaveAttribute('data-state', 'on')
  })

  it('reports its pressed state to assistive tech', () => {
    renderStrip({ agentAuthoredOnly: true })
    expect(screen.getByTestId('filter-agent-authored')).toHaveAttribute('aria-pressed', 'true')
  })
})
