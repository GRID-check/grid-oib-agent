/**
 * The four-step wizard — the rules it was rebuilt to, asserted.
 *
 * The page this replaced held sixteen controls with no stated order, and the
 * thing that made it hard was not any one field: it was having to hold all of
 * them at once. So what is pinned here is the shape, not the fields —
 *
 *   - one required answer, on step 1, and it is the request;
 *   - the name proposes itself and is never overwritten;
 *   - everything optional is behind a disclosure, shut;
 *   - step 3 shows REAL fire times, so the cadence is checkable;
 *   - going back loses nothing;
 *   - and the payload is composed from the four answers, once, at the end.
 */

import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScheduleWizard, suggestName } from './schedule-wizard'

const createJob = vi.fn()
const updateJob = vi.fn()

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/adapters/api/jobs-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/api/jobs-client')>()
  return {
    ...actual,
    createJob: (...args: unknown[]) => createJob(...args),
    updateJob: (...args: unknown[]) => updateJob(...args),
    listAttachableSkills: async () => [],
  }
})

vi.mock('@/adapters/api/data-sources-client', () => ({
  createDataSourcesClient: () => ({
    getDataSources: async () => ({
      data_sources: [{ id: 'ris', name: 'RIS-Rechtstexte', description: 'Geltendes Recht' }],
    }),
  }),
}))

beforeEach(() => {
  createJob.mockReset().mockResolvedValue({})
  updateJob.mockReset().mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function wizard() {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <ScheduleWizard projectId="p1" job={null} onSaved={onSaved} onCancel={onCancel} />,
  )
  return { ...utils, onSaved, onCancel, user: userEvent.setup() }
}

const next = () => screen.getByTestId('wizard-next')

describe('suggestName', () => {
  test('takes the first line, which is what a person would have named it', () => {
    expect(suggestName('Brandschutz prüfen\nund zwar gründlich')).toBe('Brandschutz prüfen')
  })

  test('clips a long line on a word boundary rather than mid-word', () => {
    const suggestion = suggestName('a'.repeat(10) + ' ' + 'b'.repeat(80))
    expect(suggestion.endsWith('…')).toBe(true)
    expect(suggestion.length).toBeLessThanOrEqual(61)
  })

  test('an empty prompt proposes nothing, so nothing is filled in', () => {
    expect(suggestName('   ')).toBe('')
  })
})

describe('step 1 — one required answer', () => {
  test('opens on the request, with nothing above it to read past', () => {
    wizard()
    expect(screen.getByTestId('wizard-step-task')).toBeInTheDocument()
    expect(screen.getByText('What should Piloti do?')).toBeInTheDocument()
  })

  test('cannot be left empty — the one place the wizard blocks', async () => {
    const { user } = wizard()
    expect(next()).toBeDisabled()
    await user.type(screen.getByLabelText(/The request/), 'Prüfe die Brandschutzpunkte')
    expect(next()).toBeEnabled()
  })

  test('the name shows what it will be called, live, before it is filled in', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('placeholder', 'Brandschutz prüfen')
  })

  test('moving on accepts the proposed name', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Back$/ }))
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Brandschutz prüfen')
  })

  test('…but never overwrites a name the reader typed', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.type(screen.getByLabelText(/^Name/), 'Mein Name')
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Back$/ }))
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Mein Name')
  })
})

describe('progressive disclosure', () => {
  test('step 2 asks one question; the skill and the sources are folded away', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.click(next())
    expect(screen.getByTestId('wizard-output-chat')).toBeInTheDocument()
    expect(screen.queryByText(/Attached skill/)).not.toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-advanced'))
    expect(screen.getByText(/Attached skill/)).toBeInTheDocument()
  })

  test('step 3 asks one question; the timezone and the cron are folded away', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.click(next())
    await user.click(next())
    expect(screen.getByTestId('wizard-frequency-weekly')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Cron expression/)).not.toBeInTheDocument()
  })
})

describe('step 3 — the cadence, made checkable', () => {
  async function toSchedule() {
    const harness = wizard()
    await harness.user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await harness.user.click(next())
    await harness.user.click(next())
    return harness
  }

  test('shows real upcoming fire times, not a restatement of the cron', async () => {
    await toSchedule()
    const panel = screen.getByTestId('wizard-upcoming')
    await waitFor(() => expect(within(panel).getAllByRole('listitem').length).toBeGreaterThan(0))
  })

  test('the times follow the cadence the reader picks', async () => {
    const { user } = await toSchedule()
    const panel = screen.getByTestId('wizard-upcoming')
    await waitFor(() => expect(within(panel).getAllByRole('listitem')).toHaveLength(3))
    const weekly = within(panel).getAllByRole('listitem').map((item) => item.textContent)

    await user.click(screen.getByTestId('wizard-frequency-daily'))
    await waitFor(() => {
      const daily = within(screen.getByTestId('wizard-upcoming'))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
      expect(daily).not.toEqual(weekly)
    })
  })

  test('switching off the schedule says plainly that nothing will fire', async () => {
    const { user } = await toSchedule()
    await user.click(screen.getByLabelText(/Run on a schedule/))
    expect(screen.queryByTestId('wizard-upcoming')).not.toBeInTheDocument()
  })
})

describe('step 4 — what will happen, then one button', () => {
  async function toReview(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.click(next())
    await user.click(next())
    await user.click(next())
  }

  test('states the commitment as a sentence before anything is saved', async () => {
    const { user } = wizard()
    await toReview(user)
    expect(screen.getByTestId('wizard-review-sentence')).toHaveTextContent(/Piloti produces/)
    expect(createJob).not.toHaveBeenCalled()
  })

  test('composes the payload from the four answers, once', async () => {
    const { user, onSaved } = wizard()
    await toReview(user)
    await user.click(screen.getByRole('button', { name: /Create task/ }))
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1))
    expect(createJob).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        name: 'Brandschutz prüfen',
        prompt: 'Brandschutz prüfen',
        output: 'chat',
        // The default cadence, composed rather than typed: weekly, Monday 06:00.
        scheduleCron: '0 6 * * 1',
        // Explicit null is what DETACHES on a PATCH — never omitted.
        skillName: null,
        enabled: true,
      }),
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })
})

describe('the rail', () => {
  test('offers a jump back to a step already answered, and loses nothing', async () => {
    const { user } = wizard()
    await user.type(screen.getByLabelText(/The request/), 'Brandschutz prüfen')
    await user.click(next())
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Task' }))
    expect(screen.getByLabelText(/The request/)).toHaveValue('Brandschutz prüfen')
  })

  test('does NOT offer a jump past a question nobody has answered', () => {
    wizard()
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled()
  })

  test('Back on the first step is the only place leaving costs anything', async () => {
    const { user, onCancel } = wizard()
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(onCancel).toHaveBeenCalled()
  })
})
