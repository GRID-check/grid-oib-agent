'use client'

/**
 * Dev preview for the platform overview (ADR-0016). Renders the REAL component
 * with fixture data so the stat tiles, the spend trend, the searchable/sortable
 * organization directory and the platform-team card can be reviewed and
 * screenshotted without a backend. A module-scope fetch shim (browser + dev
 * only) serves the overview payload; the WorkOS users widget is stubbed the way
 * the spec stubs it, so no widget token is ever requested. Not linked from
 * anywhere and 404s outside development.
 */

import { PlatformOverview } from '@/app/app/(shell)/platform/platform-overview'

const NAMES = [
  'GRID Platform',
  'Baumeister Wien GmbH',
  'Ziviltechnik Graz',
  'Planungsbüro Salzburg',
  'Architektur Linz',
  'Statik Innsbruck',
  'Bauphysik Klagenfurt',
  'Haustechnik Villach',
  'Projektsteuerung Bregenz',
  'Bauträger St. Pölten',
  'Ingenieurbüro Eisenstadt',
  'Generalplanung Dornbirn',
]

/** The price list the fixture is priced at: 2.5× margin, one credit = $0.10. */
const PRICING = { marginMultiplier: 2.5, usdPerCredit: 0.1, explicit: true }

/** Cost in USD as charged, priced at the fixture's price list (ADR-0053). */
const window = (costUsd: number, events: number) => ({
  costUsd,
  priceUsd: costUsd * PRICING.marginMultiplier,
  credits: (costUsd * PRICING.marginMultiplier) / PRICING.usdPerCredit,
  events,
})

// Descending month revenue, so the fixture arrives ordered the way the service
// orders it — the preview then shows the default sort, not a re-sort.
const ORGANIZATIONS = NAMES.map((name, index) => ({
  id: `org_${index}`,
  name,
  createdAt: new Date(Date.UTC(2024 + (index % 3), index % 12, 1 + index)).toISOString(),
  isPlatformOrg: index === 0,
  projectCount: (index * 3) % 11,
  day: window(Math.max(0, 18 - index * 1.4), Math.max(0, 400 - index * 30)),
  month: window(Math.max(0, 420 - index * 33), Math.max(0, 9400 - index * 700)),
}))

const DAILY_TREND = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 6, 1 + index))
  return {
    day: day.toISOString().slice(0, 10),
    ...window(40 + Math.round(Math.sin(index / 3) * 18 + index * 1.2), 800 + index * 25),
  }
})

const sumWindows = (key: 'day' | 'month') =>
  ORGANIZATIONS.reduce(
    (total, org) => ({
      costUsd: total.costUsd + org[key].costUsd,
      priceUsd: total.priceUsd + org[key].priceUsd,
      credits: total.credits + org[key].credits,
      events: total.events + org[key].events,
    }),
    { costUsd: 0, priceUsd: 0, credits: 0, events: 0 },
  )

const OVERVIEW = {
  organizations: ORGANIZATIONS,
  // Exercises the truncation copy — the honest replacement for a bare "+".
  organizationsCapped: true,
  dailyTrend: DAILY_TREND,
  totals: {
    organizations: ORGANIZATIONS.length,
    projects: ORGANIZATIONS.reduce((total, org) => total + org.projectCount, 0),
    day: sumWindows('day'),
    month: sumWindows('month'),
  },
  pricing: PRICING,
}

/** The price list card's payload: a set list with one earlier version behind it. */
const PRICING_PAYLOAD = {
  pricing: {
    versionId: 'ver_2',
    ...PRICING,
    defaultOrgDailyCredits: 500,
    defaultOrgMonthlyCredits: 5000,
    note: 'Pilot pricing',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-08-01T09:00:00Z',
    history: [
      {
        id: 'ver_2',
        marginMultiplier: 2.5,
        usdPerCredit: 0.1,
        defaultOrgDailyCredits: 500,
        defaultOrgMonthlyCredits: 5000,
        note: 'Pilot pricing',
        createdByEmail: 'owner@grid.example',
        createdAt: '2026-08-01T09:00:00Z',
        status: 'active',
      },
      {
        id: 'ver_1',
        marginMultiplier: 2,
        usdPerCredit: 0.1,
        defaultOrgDailyCredits: 1000,
        defaultOrgMonthlyCredits: 10000,
        note: null,
        createdByEmail: 'owner@grid.example',
        createdAt: '2026-07-01T09:00:00Z',
        status: 'superseded',
      },
    ],
  },
  bounds: {
    marginMultiplier: { min: 0.1, max: 50 },
    usdPerCredit: { min: 0.0001, max: 100 },
    defaultCredits: { min: 0, max: 100_000_000 },
  },
  referenceRequest: { promptTokens: 4000, completionTokens: 800 },
}

/**
 * The WorkOS Users Management widget talks to WorkOS directly, so the preview
 * stands in for it the way the spec does: a token the widget never validates
 * locally, plus the two reads it makes on mount. Without this the card would
 * render a third-party auth error next to the section under review.
 */
const WIDGET_MEMBERS = {
  data: [
    {
      id: 'user_1',
      email: 'owner@grid.example',
      emailVerified: true,
      firstName: 'Platform',
      lastName: 'Owner',
      createdAt: '2024-03-01T09:00:00Z',
      status: 'Active',
      actions: ['edit-role'],
      isLoggedInUser: true,
      roles: [{ name: 'Admin', slug: 'admin' }],
    },
    {
      id: 'user_2',
      email: 'ops@grid.example',
      emailVerified: true,
      firstName: 'Ops',
      lastName: 'Engineer',
      createdAt: '2025-01-20T09:00:00Z',
      status: 'Invited',
      actions: ['resend-invite', 'revoke-invite'],
      roles: [{ name: 'Member', slug: 'member' }],
    },
  ],
  list_metadata: { before: null, after: null },
}

const WIDGET_ROLES = {
  roles: [
    { name: 'Admin', slug: 'admin', default: false },
    { name: 'Member', slug: 'member', default: true },
  ],
  multipleRolesEnabled: false,
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformOverviewShim?: boolean }
  if (!w.__platformOverviewShim) {
    w.__platformOverviewShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/overview')) {
        return Response.json(OVERVIEW)
      }
      if (url.startsWith('/api/platform/pricing')) {
        return Response.json(PRICING_PAYLOAD)
      }
      if (url.startsWith('/api/widgets/token')) {
        return Response.json({ token: 'dev-preview-widget-token' })
      }
      if (url.startsWith('https://api.workos.com/_widgets/UserManagement/members')) {
        return Response.json(WIDGET_MEMBERS)
      }
      if (url.startsWith('https://api.workos.com/_widgets/UserManagement/roles-and-config')) {
        return Response.json(WIDGET_ROLES)
      }
      // Anything else the widget reaches for: an honest empty list beats a
      // network error box in a screenshot.
      if (url.startsWith('https://api.workos.com/_widgets/')) {
        return Response.json({ data: [], list_metadata: { before: null, after: null } })
      }
      return real(input, init)
    }
  }
}

export default function PlatformOverviewDevPage(): JSX.Element {
  return (
    <main data-testid="platform-overview-preview" className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-lg font-semibold">Platform — Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stat tiles (cost, revenue, margin), 30-day cost trend, the price list, the organization directory on
          SectionCard + DataToolbar + Table + Pagination, and the platform team in its own card.
        </p>
      </div>
      <PlatformOverview />
    </main>
  )
}
