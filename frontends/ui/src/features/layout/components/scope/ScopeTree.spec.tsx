/**
 * The tree REPORTS and it MOUNTS; it does not toggle.
 *
 * So what these tests hold is not "the rows render" but the three promises the
 * design makes about them: the register row exists on both surfaces and says
 * which one it is on, a row nobody can press states WHY where it would have
 * been pressed, and the only two writes in the whole control are mounting and
 * unmounting.
 */

import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ScopeTree } from './ScopeTree'
import { buildScopeLevels } from './scope-tree-model'

const props = {
  cap: 5,
  onMount: vi.fn(),
  onUnmount: vi.fn(),
  onDeepResearch: vi.fn(),
}

const workspaceLevels = (
  input: Partial<Parameters<typeof buildScopeLevels>[0]> = {}
) =>
  buildScopeLevels({
    scope: 'workspace',
    mounted: [
      { projectId: 'a', projectName: 'Seestadt Nord' },
      { projectId: 'b', projectName: 'Rosenhügel', mountedBy: 'agent' },
    ],
    ...input,
  })

describe('the hierarchy', () => {
  it('renders all six levels in authority order on BOTH surfaces', () => {
    const { rerender } = render(<ScopeTree {...props} levels={workspaceLevels()} />)
    const ids = () =>
      screen
        .getAllByTestId(/^scope-level-/)
        .map((row) => row.dataset.testid ?? row.getAttribute('data-testid'))
    expect(ids()).toEqual([
      'scope-level-base',
      'scope-level-archiv',
      'scope-level-register',
      'scope-level-project',
      'scope-level-memory',
      'scope-level-session',
    ])

    rerender(
      <ScopeTree
        {...props}
        levels={buildScopeLevels({ scope: 'project', projectName: 'Seestadt Nord' })}
      />
    )
    expect(ids()).toEqual([
      'scope-level-base',
      'scope-level-archiv',
      'scope-level-register',
      'scope-level-project',
      'scope-level-memory',
      'scope-level-session',
    ])
  })

  it('shows the register as readable in the Büro and as a closed door outside it', () => {
    const { rerender } = render(<ScopeTree {...props} levels={workspaceLevels()} />)
    expect(screen.getByTestId('scope-level-register').dataset.state).toBe('always')

    rerender(
      <ScopeTree {...props} levels={buildScopeLevels({ scope: 'project', projectName: 'X' })} />
    )
    expect(screen.getByTestId('scope-level-register').dataset.state).toBe('unavailable')
    expect(screen.getByText('Only in the office chat.')).toBeInTheDocument()
  })

  it('states every level’s status IN WORDS, not only in colour', () => {
    render(<ScopeTree {...props} levels={workspaceLevels()} />)
    const base = screen.getByTestId('scope-level-base')
    expect(within(base).getByText('always')).toBeInTheDocument()
  })
})

describe('the mounted list', () => {
  it('names every project in view and removes by id', async () => {
    const onUnmount = vi.fn()
    render(<ScopeTree {...props} onUnmount={onUnmount} levels={workspaceLevels()} />)

    expect(screen.getByText('Seestadt Nord')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Remove Rosenhügel/ }))

    expect(onUnmount).toHaveBeenCalledWith('b')
  })

  it('replaces the remove control with a spinner while it is in flight', () => {
    render(<ScopeTree {...props} pending={['a']} levels={workspaceLevels()} />)
    expect(screen.queryByRole('button', { name: /Remove Seestadt Nord/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Remove Rosenhügel/ })).toBeInTheDocument()
  })

  it('says that nothing is in view rather than showing an empty gap', () => {
    render(<ScopeTree {...props} levels={workspaceLevels({ mounted: [] })} />)
    expect(screen.getByText('No project in view')).toBeInTheDocument()
  })
})

describe('the cap', () => {
  it('withholds the add row and puts the REASON where the reader would have pressed it', () => {
    render(<ScopeTree {...props} levels={workspaceLevels({ canMount: false })} />)
    expect(screen.queryByTestId('scope-tree-mount-add')).toBeNull()
    expect(screen.getByTestId('scope-tree-cap-reason')).toHaveTextContent(
      'cannot read more than 5 projects'
    )
  })

  it('keeps the list visible at the cap — the projects are still in view', () => {
    render(<ScopeTree {...props} levels={workspaceLevels({ canMount: false })} />)
    expect(screen.getByText('Seestadt Nord')).toBeInTheDocument()
  })
})

describe('an excluded level', () => {
  it('names the preset that excluded it AND offers the way back', async () => {
    const onResetPreset = vi.fn()
    render(
      <ScopeTree
        {...props}
        onResetPreset={onResetPreset}
        levels={workspaceLevels({
          preset: { label: 'Office archive', excludes: ['project'] },
        })}
      />
    )

    expect(screen.getByText(/Excluded by/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset the preset' }))
    expect(onResetPreset).toHaveBeenCalled()
  })

  it('does not offer a reset where nothing was excluded — there is nothing to undo', () => {
    render(
      <ScopeTree {...props} onResetPreset={vi.fn()} levels={workspaceLevels({ mounted: [] })} />
    )
    expect(screen.queryByRole('button', { name: 'Reset the preset' })).toBeNull()
  })
})

describe('the doorway out of a project chat', () => {
  it('offers "Ask in the office" in a project chat, and nothing in the Büro', async () => {
    const onAskInWorkspace = vi.fn()
    const { rerender } = render(
      <ScopeTree
        {...props}
        onAskInWorkspace={onAskInWorkspace}
        levels={buildScopeLevels({ scope: 'project', projectName: 'Seestadt Nord' })}
      />
    )
    await userEvent.click(screen.getByTestId('ask-in-workspace'))
    expect(onAskInWorkspace).toHaveBeenCalled()

    rerender(<ScopeTree {...props} levels={workspaceLevels()} />)
    expect(screen.queryByTestId('ask-in-workspace')).toBeNull()
  })
})

describe('a refusal', () => {
  it('is shown inline with a retry, never as an empty tree', async () => {
    const onRetry = vi.fn()
    render(
      <ScopeTree
        {...props}
        error="That project could not be added right now."
        onRetry={onRetry}
        levels={workspaceLevels()}
      />
    )
    expect(screen.getByText('That project could not be added right now.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })
})


/**
 * The level ADR-0055 added, and the one property it exists for: a layer read on
 * EVERY turn states, where it is read, how much of itself the turn saw.
 */
describe('the memory level', () => {
  const carried = { memory: { carried: 3, total: 47, omitted: 44 } }

  it('states carried-of-total on both surfaces', () => {
    const { rerender } = render(<ScopeTree {...props} levels={workspaceLevels(carried)} />)
    expect(screen.getByTestId('scope-tree-memory-counts')).toHaveTextContent('3')
    expect(screen.getByTestId('scope-tree-memory-counts')).toHaveTextContent('47')

    rerender(
      <ScopeTree
        {...props}
        levels={buildScopeLevels({ scope: 'project', projectName: 'Seestadt Nord', ...carried })}
      />
    )
    expect(screen.getByTestId('scope-tree-memory-counts')).toHaveTextContent('3')
    expect(screen.getByTestId('scope-tree-memory-counts')).toHaveTextContent('47')
  })

  it('says in the READER\'s words how many were left out', () => {
    render(<ScopeTree {...props} levels={workspaceLevels(carried)} />)
    // The same number the digest discloses to the MODEL. The two diverging is
    // the inversion this level exists to close, so the count is asserted here
    // and not merely the presence of a sentence.
    expect(screen.getByTestId('scope-tree-memory-omitted')).toHaveTextContent('44')
  })

  it('says nothing about counts before a turn has reported any', () => {
    render(<ScopeTree {...props} levels={workspaceLevels()} />)
    expect(screen.getByTestId('scope-level-memory').dataset.state).toBe('always')
    expect(screen.queryByTestId('scope-tree-memory-counts')).not.toBeInTheDocument()
  })

  it('is a closed door in the Büro with no organization memory, and says why', () => {
    render(
      <ScopeTree
        {...props}
        levels={workspaceLevels({ hasOrganizationMemory: false })}
      />
    )
    const row = screen.getByTestId('scope-level-memory')
    expect(row.dataset.state).toBe('unavailable')
    // The reason is stated, not implied by the dimming: a row that cannot be
    // opened and does not say why is the shape this design is written against.
    expect(screen.getByText('Nothing remembered for your organization yet.')).toBeInTheDocument()
  })

  it('links to the panel rather than becoming a page of its own', async () => {
    const onOpenMemory = vi.fn()
    const user = userEvent.setup()
    render(<ScopeTree {...props} levels={workspaceLevels(carried)} onOpenMemory={onOpenMemory} />)
    await user.click(screen.getByTestId('scope-tree-memory-open'))
    expect(onOpenMemory).toHaveBeenCalledTimes(1)
  })
})
