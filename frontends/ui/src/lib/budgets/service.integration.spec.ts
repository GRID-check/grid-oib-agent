/**
 * Opt-in integration test: runs the REAL budget queries against a REAL
 * Postgres with migrations 0012/0013 applied. Skipped unless
 * GRID_TEST_DATABASE_URL is set (CI has no database).
 *
 *   GRID_TEST_DATABASE_URL=postgres://user@host:port/grid_app npx vitest run \
 *     src/lib/budgets/service.integration.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

describe.skipIf(!url)('budgets service against live Postgres', () => {
  beforeAll(() => {
    process.env.GRID_APP_DATABASE_URL = url
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('records events, aggregates spend per model, computes budget status', async () => {
    const { getBudgetStatus, getOrgBudget, getSpendSummary, recordUsageEvents, setBudgetPolicy } = await import(
      './service'
    )

    const org = `org_test_${Date.now()}`

    // Empty ledger: zeros, seeded default limits, not blocked.
    const empty = await getSpendSummary(org)
    expect(empty).toEqual({ dayUsd: 0, monthUsd: 0, perModel: [] })
    const orgBudget = await getOrgBudget(org)
    expect(orgBudget).toMatchObject({ explicit: false, dailyLimitEur: 10, monthlyLimitEur: 100 })

    // Ledger rows: two models, shaped exactly like the internal usage endpoint writes them.
    await recordUsageEvents([
      {
        organizationId: org,
        userId: 'user_1',
        projectId: null,
        conversationId: 'conv-1',
        jobId: null,
        requestedModel: 'deepseek/deepseek-v4-flash',
        model: 'deepseek/deepseek-v4-flash',
        generationId: 'gen-1',
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        cachedTokens: 0,
        reasoningTokens: 0,
        costUsd: '0.00214000',
        costSource: 'usage_field',
        isByok: false,
      },
      {
        organizationId: org,
        userId: 'user_2',
        projectId: null,
        conversationId: 'conv-2',
        jobId: null,
        requestedModel: null,
        model: 'anthropic/claude-sonnet-4.5',
        generationId: 'gen-2',
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
        cachedTokens: 0,
        reasoningTokens: 50,
        costUsd: '0.01000000',
        costSource: 'usage_field',
        isByok: null,
      },
    ])

    const summary = await getSpendSummary(org)
    expect(summary.perModel).toHaveLength(2)
    expect(summary.monthUsd).toBeCloseTo(0.01214, 6)
    expect(summary.dayUsd).toBeCloseTo(0.01214, 6)
    const models = Object.fromEntries(summary.perModel.map((m) => [m.model, m]))
    expect(models['anthropic/claude-sonnet-4.5'].monthUsd).toBeCloseTo(0.01, 6)
    expect(models['deepseek/deepseek-v4-flash'].dayEvents).toBe(1)

    // Member filter narrows the window.
    const userSummary = await getSpendSummary(org, { userId: 'user_1' })
    expect(userSummary.monthUsd).toBeCloseTo(0.00214, 6)

    // Budget status with seeded defaults: far under €10/day → not blocked.
    const status = await getBudgetStatus(org, 'user_1', null)
    expect(status.blocked).toBe(false)
    expect(status.remainingOrgUsd).toBeGreaterThan(0)
    expect(status.remainingUserUsd).toBeNull() // no member policy set

    // Set an explicit tiny org limit → blocked; supersede idiom kicks in.
    await setBudgetPolicy({
      organizationId: org,
      scope: 'organization',
      subjectId: null,
      dailyLimitEur: 0.001,
      monthlyLimitEur: 100,
      actorUserId: 'admin_1',
    })
    const blocked = await getBudgetStatus(org, 'user_1', null)
    expect(blocked.blocked).toBe(true)
    expect(blocked.blockedScope).toBe('organization')

    // Member limit above org limit is rejected.
    await expect(
      setBudgetPolicy({
        organizationId: org,
        scope: 'member',
        subjectId: 'user_1',
        dailyLimitEur: 5,
        monthlyLimitEur: 200,
        actorUserId: 'admin_1',
      }),
    ).rejects.toThrow(/exceeds the organization/)
  })
})
