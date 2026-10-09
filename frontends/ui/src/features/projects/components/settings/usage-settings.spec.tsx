import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { UsageSettings, type ProjectUsageView } from './usage-settings'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const usage = (overrides: Partial<ProjectUsageView> = {}): ProjectUsageView => ({
  unit: 'credit',
  day: { amount: 10, events: 4 },
  month: { amount: 120, events: 40 },
  perModel: [{ model: 'anthropic/claude-sonnet-5-5', month: { amount: 120, events: 40 } }],
  projectLimit: null,
  orgLimit: { dailyLimit: 100, monthlyLimit: 1000 },
  blockedScope: null,
  dailyTrend: [],
  ...overrides,
})

describe('UsageSettings', () => {
  test('without a project limit, says only the organization’s applies', () => {
    render(<UsageSettings projectId="p1" usage={usage()} canEditLimit />)

    expect(screen.getByTestId('project-limit')).toHaveTextContent(
      'No project limit. Only the organization’s limit applies.'
    )
    expect(screen.getByRole('button', { name: 'Set limit' })).toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-sonnet-5-5')).toBeInTheDocument()
  })

  test('meters against the tighter of the project and organization limits', () => {
    render(
      <UsageSettings
        projectId="p1"
        usage={usage({ projectLimit: { dailyLimit: 5, monthlyLimit: null } })}
        canEditLimit
      />
    )

    // Today: 10 spent against the project's 5, so the meter reads over.
    expect(screen.getAllByTestId('budget-meter-over')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Change limit' })).toBeInTheDocument()
  })

  test('says which limit has stopped the project', () => {
    render(<UsageSettings projectId="p1" usage={usage({ blockedScope: 'project' })} canEditLimit />)

    expect(
      screen.getByText('This project’s limit is exhausted. New requests here are blocked.')
    ).toBeInTheDocument()
  })

  test('offers no editor to a reader who may not set the limit', () => {
    render(<UsageSettings projectId="p1" usage={usage()} canEditLimit={false} />)

    expect(screen.queryByRole('button', { name: 'Set limit' })).not.toBeInTheDocument()
  })

  test('an empty month is said, not drawn', () => {
    render(<UsageSettings projectId="p1" usage={usage({ perModel: [] })} canEditLimit />)

    expect(screen.getByText('No usage recorded in this project this month.')).toBeInTheDocument()
  })
})
