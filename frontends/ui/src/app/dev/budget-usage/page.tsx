'use client'

/**
 * Dev preview for the organization "Usage & budgets" card. Renders the REAL
 * card twice — the admin view (meters, 30-day trend, composition bar + table,
 * limit editors, member and project limits) and the member view (the same
 * spend visualization without any editor) — so the visualization can be
 * reviewed and screenshotted without a backend.
 *
 * The fixture is deliberately awkward for a chart: ten models, so the tail has
 * to fold into "Other"; a long OpenRouter-style model id, so truncation is
 * exercised; a month meter deliberately pushed over its limit, so the over
 * state and the limit tick are both on screen; and a day meter comfortably
 * under, so both meter states are visible side by side.
 *
 * A module-scope fetch shim (browser + dev only) serves the four endpoints the
 * card reaches for. Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { Gauge } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BudgetUsageCard } from '../../app/(shell)/organization/budget-usage-card'

const MODELS = [
  {
    model: 'anthropic/claude-opus-4.6',
    dayUsd: 3.9,
    monthUsd: 61.4,
    dayEvents: 41,
    monthEvents: 812,
  },
  { model: 'openai/gpt-5.2', dayUsd: 2.1, monthUsd: 24.8, dayEvents: 33, monthEvents: 501 },
  { model: 'google/gemini-3.0-pro', dayUsd: 0.9, monthUsd: 12.2, dayEvents: 18, monthEvents: 288 },
  { model: 'mistralai/mistral-large-2', dayUsd: 0, monthUsd: 6.4, dayEvents: 0, monthEvents: 140 },
  {
    model: 'meta-llama/llama-4-70b-instruct-turbo',
    dayUsd: 0.4,
    monthUsd: 4.1,
    dayEvents: 9,
    monthEvents: 96,
  },
  { model: 'cohere/command-r-plus', dayUsd: 0.2, monthUsd: 2.6, dayEvents: 5, monthEvents: 61 },
  { model: 'qwen/qwen3-235b', dayUsd: 0, monthUsd: 1.4, dayEvents: 0, monthEvents: 30 },
  { model: 'deepseek/deepseek-v4', dayUsd: 0.1, monthUsd: 0.9, dayEvents: 2, monthEvents: 22 },
  { model: 'x-ai/grok-4', dayUsd: 0.05, monthUsd: 0.6, dayEvents: 1, monthEvents: 14 },
  { model: 'zhipu/glm-5', dayUsd: 0.02, monthUsd: 0.3, dayEvents: 1, monthEvents: 8 },
]

const DAY_USD = MODELS.reduce((sum, m) => sum + m.dayUsd, 0)
const MONTH_USD = MODELS.reduce((sum, m) => sum + m.monthUsd, 0)

/** Deterministic 30-day series with a visible ramp and two quiet days. */
const DAILY_TREND = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 5, 29))
  day.setUTCDate(day.getUTCDate() + index)
  const quiet = index === 6 || index === 20
  const usd = quiet ? 0 : 1.4 + (index % 7) * 0.55 + (index > 21 ? 2.4 : 0)
  return {
    day: day.toISOString().slice(0, 10),
    usd: Number(usd.toFixed(2)),
    events: quiet ? 0 : 30 + (index % 9) * 7,
  }
})

const USAGE = {
  summary: { dayUsd: DAY_USD, monthUsd: MONTH_USD, perModel: MODELS },
  perMember: [
    { userId: 'user_01', dayUsd: 4.2, monthUsd: 48.9, dayEvents: 52, monthEvents: 704 },
    { userId: 'user_02', dayUsd: 2.3, monthUsd: 39.1, dayEvents: 31, monthEvents: 610 },
    { userId: 'user_03', dayUsd: 0.9, monthUsd: 22.4, dayEvents: 14, monthEvents: 402 },
  ],
  // The month is deliberately over its limit and the day comfortably under, so
  // both meter states — and the over-limit tick — are on screen at once.
  orgBudget: { dailyLimitEur: 25, monthlyLimitEur: 100, explicit: true },
  status: { blocked: true, blockedScope: 'organization' },
  eurPerUsd: 0.92,
  dailyTrend: DAILY_TREND,
}

const BUDGETS = {
  organization: { dailyLimitEur: 25, monthlyLimitEur: 100 },
  policies: [
    {
      id: 'pol_1',
      scope: 'member',
      subjectId: 'user_02',
      dailyLimit: '5.00',
      monthlyLimit: '40.00',
    },
    {
      id: 'pol_2',
      scope: 'project',
      subjectId: 'proj_1',
      dailyLimit: null,
      monthlyLimit: '30.00',
    },
  ],
}

const MEMBERS = {
  members: [
    { id: 'user_01', email: 'anna.berger@bauwerk.test', name: 'Anna Berger' },
    { id: 'user_02', email: 'tom.hofer@bauwerk.test', name: 'Tom Hofer' },
    { id: 'user_03', email: 'lea.mayr@bauwerk.test', name: null },
  ],
}

const PROJECTS = [
  { id: 'proj_1', name: 'Wohnbau Nord — Brandschutz' },
  { id: 'proj_2', name: 'Sanierung Hauptplatz' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __budgetUsageShim?: boolean }
  if (!w.__budgetUsageShim) {
    w.__budgetUsageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/organization/usage')) return Response.json(USAGE)
      if (url.startsWith('/api/organization/budgets')) return Response.json(BUDGETS)
      if (url.startsWith('/api/organization/members')) return Response.json(MEMBERS)
      if (url.startsWith('/api/projects')) return Response.json(PROJECTS)
      return real(input, init)
    }
  }
}

export default function BudgetUsageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="budget-usage-preview">
      <div>
        <h1 className="text-lg font-semibold">Organization — Usage &amp; budgets</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Spend against the limits that stop it: two meters, a 30-day trend, part-to-whole by model
          and its table twin.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="text-muted-foreground size-4" aria-hidden />
            Usage &amp; budgets — admin
          </CardTitle>
          <CardDescription>
            LLM spend per model against your organization limits, plus the limit editors.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetUsageCard isAdmin />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="text-muted-foreground size-4" aria-hidden />
            Your usage — member
          </CardTitle>
          <CardDescription>The same visualization without any editor.</CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetUsageCard isAdmin={false} />
        </CardContent>
      </Card>
    </main>
  )
}
