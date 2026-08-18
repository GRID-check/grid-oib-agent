import { render, screen, waitFor, within } from '@/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { BudgetUsageCard } from './budget-usage-card'

/**
 * These pin the *visualization* decisions, not the budget arithmetic — the
 * things a later refactor is most likely to undo without noticing:
 *
 * - colour follows the model, ordering follows the money. A reader who learned
 *   that a model is blue must keep seeing it blue when the leaderboard changes,
 *   so slots are handed out alphabetically while rows are sorted by spend.
 * - the ninth model folds into a neutral "Other" instead of getting a generated
 *   hue, and Other is pinned last however much it spent.
 * - every number is readable without hovering. Three of the eight light-mode
 *   slots sit below 3:1 on white, which the method only permits when the values
 *   are also present as text — so the table is always open, never a toggle.
 * - the meter carries state, which is why it stopped being painted by model.
 */

interface ModelFixture {
  model: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

const usageBody = (
  perModel: ModelFixture[],
  orgBudget: { dailyLimitEur: number | null; monthlyLimitEur: number | null } = {
    dailyLimitEur: null,
    monthlyLimitEur: null,
  }
): unknown => ({
  summary: {
    dayUsd: perModel.reduce((sum, m) => sum + m.dayUsd, 0),
    monthUsd: perModel.reduce((sum, m) => sum + m.monthUsd, 0),
    perModel,
  },
  perMember: null,
  orgBudget: { ...orgBudget, explicit: true },
  status: { blocked: false },
  eurPerUsd: 1,
})

const model = (name: string, dayUsd: number, monthUsd: number): ModelFixture => ({
  model: name,
  dayUsd,
  monthUsd,
  dayEvents: Math.round(dayUsd),
  monthEvents: Math.round(monthUsd),
})

/** Answers only the two endpoints a non-admin card reaches for. */
function stubFetch(usage: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/usage')
        ? usage
        : { organization: { dailyLimitEur: null, monthlyLimitEur: null }, policies: [] }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    })
  )
}

const rowNames = (): string[] =>
  within(screen.getByTestId('spend-table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('.font-mono')?.textContent ?? '')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BudgetUsageCard — spend visualization', () => {
  test('assigns colour by model id and order by spend, so a rank change never repaints', async () => {
    stubFetch(
      usageBody([
        model('alpha-model', 1, 30),
        model('mid-model', 0, 10),
        model('zeta-model', 5, 60),
      ])
    )
    render(<BudgetUsageCard isAdmin={false} />)

    const bar = await screen.findByTestId('spend-composition')
    // Table rows read biggest-first — rows don't touch, so rank is free…
    expect(rowNames()).toEqual(['zeta-model', 'alpha-model', 'mid-model'])
    // …but the stack goes in PALETTE order, because only adjacent slots have a
    // validated colourblind separation and stacking by size would put arbitrary
    // pairs together. The hue is bound to the alphabetical slot either way, so
    // the biggest spender is not slot 1.
    const fills = Array.from(bar.children).map((el) => (el as HTMLElement).style.backgroundColor)
    expect(fills).toEqual([
      'var(--spend-series-1)', // alpha-model
      'var(--spend-series-2)', // mid-model
      'var(--spend-series-3)', // zeta-model — third alphabetically, biggest spender
    ])
  })

  test('folds the ninth model into a neutral Other, pinned last', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      // The tail models are the alphabetically last two but the biggest spenders,
      // so a rank-ordered fold would have put them in a slot.
      model(`model-${String(i).padStart(2, '0')}`, 0, i >= 8 ? 500 : 10)
    )
    stubFetch(usageBody(many))
    render(<BudgetUsageCard isAdmin={false} />)

    const bar = await screen.findByTestId('spend-composition')
    const fills = Array.from(bar.children).map((el) => (el as HTMLElement).style.backgroundColor)
    expect(fills).toHaveLength(9)
    expect(fills.filter((fill) => fill === 'var(--spend-other)')).toEqual(['var(--spend-other)'])
    expect(fills.at(-1)).toBe('var(--spend-other)')
    expect(rowNames().at(-1)).toContain('Other models')
  })

  test('prints every value as text, so nothing is reachable only by hovering', async () => {
    stubFetch(usageBody([model('alpha-model', 1, 30), model('zeta-model', 5, 60)]))
    render(<BudgetUsageCard isAdmin={false} />)

    await screen.findByTestId('spend-table')
    const table = screen.getByTestId('spend-table')
    // Month spend, today's spend and the request counts all live in the table.
    expect(within(table).getByText('€60.00')).toBeDefined()
    expect(within(table).getByText('€30.00')).toBeDefined()
    expect(within(table).getByText('€5.00')).toBeDefined()
    expect(within(table).getByText('€1.00')).toBeDefined()
    expect(within(table).getByText('60 requests')).toBeDefined()
  })

  test('the meter carries state: within the limit, then over it with the limit marked', async () => {
    stubFetch(
      usageBody([model('alpha-model', 2, 120)], { dailyLimitEur: 10, monthlyLimitEur: 100 })
    )
    render(<BudgetUsageCard isAdmin={false} />)

    await waitFor(() => expect(screen.getAllByTestId(/^budget-meter-/)).toHaveLength(2))
    const [today, month] = screen.getAllByTestId(/^budget-meter-/)
    expect(today.dataset.testid).toBe('budget-meter-within')
    expect(month.dataset.testid).toBe('budget-meter-over')

    // Under the limit the fill is the accent; at or over it, the status step.
    expect((today.firstElementChild as HTMLElement).style.backgroundColor).toBe(
      'var(--spend-meter)'
    )
    expect((month.firstElementChild as HTMLElement).style.backgroundColor).toBe(
      'var(--spend-meter-over)'
    )
    // The overshoot is only legible if the limit is still marked on the track.
    expect(within(month).getByTestId('budget-limit-tick')).toBeDefined()
    expect(within(today).queryByTestId('budget-limit-tick')).toBeNull()
    expect(screen.getByText('€120.00 of €100.00')).toBeDefined()
  })

  test('says so in words when nothing was spent, rather than drawing an empty bar', async () => {
    stubFetch(usageBody([]))
    render(<BudgetUsageCard isAdmin={false} />)

    expect(await screen.findByText('No LLM usage recorded in this window yet.')).toBeDefined()
    expect(screen.queryByTestId('spend-composition')).toBeNull()
    expect(screen.queryByTestId('spend-table')).toBeNull()
  })
})
