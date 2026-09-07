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

import { notFound } from 'next/navigation'
import { Gauge } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BudgetUsageCard } from '../../app/(shell)/organization/budget-usage-card'

/** Amounts in the tenant's unit (ADR-0053) — credits here; the card never sees cost. */
const window = (amount: number, events: number) => ({ amount, events })

const MODELS = [
  { model: 'anthropic/claude-opus-4.6', day: window(390, 41), month: window(6140, 812) },
  { model: 'openai/gpt-5.2', day: window(210, 33), month: window(2480, 501) },
  { model: 'google/gemini-3.0-pro', day: window(90, 18), month: window(1220, 288) },
  { model: 'mistralai/mistral-large-2', day: window(0, 0), month: window(640, 140) },
  { model: 'meta-llama/llama-4-70b-instruct-turbo', day: window(40, 9), month: window(410, 96) },
  { model: 'cohere/command-r-plus', day: window(20, 5), month: window(260, 61) },
  { model: 'qwen/qwen3-235b', day: window(0, 0), month: window(140, 30) },
  { model: 'deepseek/deepseek-v4', day: window(10, 2), month: window(90, 22) },
  { model: 'x-ai/grok-4', day: window(5, 1), month: window(60, 14) },
  { model: 'zhipu/glm-5', day: window(2, 1), month: window(30, 8) },
]

const DAY = window(
  MODELS.reduce((sum, m) => sum + m.day.amount, 0),
  MODELS.reduce((sum, m) => sum + m.day.events, 0),
)
const MONTH = window(
  MODELS.reduce((sum, m) => sum + m.month.amount, 0),
  MODELS.reduce((sum, m) => sum + m.month.events, 0),
)

/** Deterministic 30-day series with a visible ramp and two quiet days. */
const DAILY_TREND = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 5, 29))
  day.setUTCDate(day.getUTCDate() + index)
  const quiet = index === 6 || index === 20
  const amount = quiet ? 0 : 140 + (index % 7) * 55 + (index > 21 ? 240 : 0)
  return {
    day: day.toISOString().slice(0, 10),
    amount,
    events: quiet ? 0 : 30 + (index % 9) * 7,
  }
})

const USAGE = {
  unit: 'credit',
  summary: { day: DAY, month: MONTH, perModel: MODELS },
  perMember: [
    { userId: 'user_01', day: window(420, 52), month: window(4890, 704) },
    { userId: 'user_02', day: window(230, 31), month: window(3910, 610) },
    { userId: 'user_03', day: window(90, 14), month: window(2240, 402) },
  ],
  // The month is deliberately over its limit and the day comfortably under, so
  // both meter states — and the over-limit tick — are on screen at once.
  orgBudget: { dailyLimit: 2500, monthlyLimit: 10000, explicit: true },
  status: { blocked: true, blockedScope: 'organization' },
  dailyTrend: DAILY_TREND,
}

const BUDGETS = {
  organization: { dailyLimit: 2500, monthlyLimit: 10000 },
  policies: [
    {
      id: 'pol_1',
      scope: 'member',
      subjectId: 'user_02',
      dailyLimit: '500.0000',
      monthlyLimit: '4000.0000',
    },
    {
      id: 'pol_2',
      scope: 'project',
      subjectId: 'proj_1',
      dailyLimit: null,
      monthlyLimit: '3000.0000',
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
