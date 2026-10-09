import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'

import type { QualityScope } from '@/lib/quality/scope'
import { customRangeError, QualityScopeBar, withOrganizations, type QualityScopeOptionsState } from './quality-scope-bar'

const SCOPE: QualityScope = { from: '2026-09-01', to: '2026-09-30', organizationIds: [], projectIds: [] }
const OPTIONS: QualityScopeOptionsState = {
  loading: false,
  failed: false,
  options: {
    organizations: [
      { id: 'org_a', name: 'Atelier Nord' },
      { id: 'org_b', name: null },
    ],
    organizationsTruncated: false,
    projects: [
      { id: 'p1', name: 'Stadthaus', organizationId: 'org_a' },
      { id: 'p2', name: 'Schule', organizationId: 'org_b' },
    ],
    projectsTruncated: false,
  },
}

describe('customRangeError', () => {
  it('accepts what the API accepts, and names what it would refuse', () => {
    expect(customRangeError('2026-01-01', '2026-12-31')).toBeNull()
    expect(customRangeError('2026-01-01', '')).toBe('invalid')
    expect(customRangeError('2026-10-02', '2026-10-01')).toBe('inverted')
    expect(customRangeError('2024-01-01', '2026-01-01')).toBe('tooLong')
  })
})

describe('withOrganizations', () => {
  const owners = new Map([
    ['p1', 'org_a'],
    ['p2', 'org_b'],
  ])

  it('drops the projects no chosen organization owns, and all of them with no organization', () => {
    const scope = { ...SCOPE, organizationIds: ['org_a', 'org_b'], projectIds: ['p1', 'p2', 'p_unknown'] }
    expect(withOrganizations(scope, ['org_a'], owners).projectIds).toEqual(['p1', 'p_unknown'])
    expect(withOrganizations(scope, [], owners).projectIds).toEqual([])
  })
})

describe('QualityScopeBar', () => {
  it('asks for an organization before it offers projects', () => {
    render(<QualityScopeBar scope={SCOPE} onScopeChange={vi.fn()} options={OPTIONS} />)
    const projects = screen.getByRole('combobox', { name: 'Projects' })
    expect(projects).toBeDisabled()
    expect(projects).toHaveTextContent('Choose an organization first')
  })

  it('lists the projects of the chosen organization only, and names an unnamed one by its id', async () => {
    const user = userEvent.setup()
    render(<QualityScopeBar scope={{ ...SCOPE, organizationIds: ['org_a'] }} onScopeChange={vi.fn()} options={OPTIONS} />)

    await user.click(screen.getByRole('combobox', { name: 'Projects' }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['Stadthaus'])

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('combobox', { name: 'Organizations' }))
    expect(await screen.findByRole('option', { name: 'org_b' })).toBeInTheDocument()
  })

  it('marks the preset the range is, and the custom range otherwise', () => {
    const { rerender } = render(<QualityScopeBar scope={SCOPE} onScopeChange={vi.fn()} options={OPTIONS} />)
    expect(screen.getByTestId('quality-range-custom')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('quality-range-custom')).toHaveTextContent('2026')

    const today = new Date().toISOString().slice(0, 10)
    const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
    rerender(<QualityScopeBar scope={{ ...SCOPE, from: weekAgo, to: today }} onScopeChange={vi.fn()} options={OPTIONS} />)
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('data-state', 'on')
  })

  it('applies a custom range only once it is one the API accepts', async () => {
    const user = userEvent.setup()
    const onScopeChange = vi.fn()
    render(<QualityScopeBar scope={SCOPE} onScopeChange={onScopeChange} options={OPTIONS} />)

    await user.click(screen.getByTestId('quality-range-custom'))
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-10-05' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })
    expect(screen.getByText('The end is before the start.')).toBeInTheDocument()
    expect(screen.getByTestId('quality-range-apply')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-01' } })
    await user.click(screen.getByTestId('quality-range-apply'))
    expect(onScopeChange).toHaveBeenCalledWith({ ...SCOPE, from: '2026-07-01', to: '2026-10-01' })
  })

  it('says when the organizations could not be loaded', () => {
    render(<QualityScopeBar scope={SCOPE} onScopeChange={vi.fn()} options={{ options: null, loading: false, failed: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The organizations could not be loaded.')
  })
})
