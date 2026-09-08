/**
 * The scope chip is the LAST carrier of "where am I" standing: below `sm` its
 * label is gone and the glyph is alone, and a reader who never opens the tree
 * hears the whole state only through the accessible name. So what these tests
 * hold is the glyph per variant and that the name spells the count out.
 */

import { render, screen } from '@/test-utils'
import { describe, expect, it } from 'vitest'
import { ScopeChip } from './ScopeChip'

describe('the glyph carries the scope', () => {
  it('draws the lock in a project chat', () => {
    render(<ScopeChip variant="project" label="Seestadt Nord" />)
    const chip = screen.getByTestId('scope-chip')
    expect(chip.dataset.scopeVariant).toBe('project')
    expect(chip.querySelector('.lucide-lock')).not.toBeNull()
  })

  it('draws the building in the Büro', () => {
    render(<ScopeChip variant="workspace" label="Büro" />)
    expect(screen.getByTestId('scope-chip').querySelector('.lucide-building2')).not.toBeNull()
  })
})

describe('the accessible name states the whole scope', () => {
  it('names the project in a project chat', () => {
    render(<ScopeChip variant="project" label="Seestadt Nord" />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/Seestadt Nord/)
  })

  it('says no project is in view at zero', () => {
    render(<ScopeChip variant="workspace" label="Büro" mountedCount={0} />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/No project in view/)
  })

  it('counts one and many apart', () => {
    const { rerender } = render(<ScopeChip variant="workspace" label="Büro" mountedCount={1} />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/1 project in view/)
    rerender(<ScopeChip variant="workspace" label="Büro" mountedCount={3} />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/3 projects in view/)
  })
})

describe('the count', () => {
  it('is not rendered at zero — a number about nothing', () => {
    render(<ScopeChip variant="workspace" label="Büro" mountedCount={0} />)
    expect(screen.queryByText('0')).toBeNull()
  })

  it('rides the chip from one upward, where a narrow viewport keeps it', () => {
    render(<ScopeChip variant="workspace" label="Büro" mountedCount={2} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})

it('is disabled for a read-only participant', () => {
  render(<ScopeChip variant="workspace" label="Büro" disabled />)
  expect(screen.getByRole('button')).toBeDisabled()
})
