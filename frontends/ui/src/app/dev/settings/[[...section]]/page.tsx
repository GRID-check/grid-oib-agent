'use client'

/**
 * Dev preview for the project Settings tier: the section nav and every section,
 * rendered through the REAL section organisms with a module-scope fetch shim
 * for what they load in the browser (roster, memory, uploads, summary).
 *
 *   /dev/settings            General
 *   /dev/settings/profile    Project profile + applicable standards
 *   /dev/settings/members    Members
 *   /dev/settings/memory     Memory
 *   /dev/settings/usage      Usage & budget (`?blocked=project` shows the exhausted state)
 *   /dev/settings/documents  Documents & index
 *
 * `?as=viewer` renders what a project viewer gets: no rename, no danger zone, a
 * read-only memory, no reindex, and no Members or Usage section at all.
 *
 * Not linked from anywhere; `src/app/dev/layout.tsx` 404s it outside development.
 */

import type { JSX } from 'react'
import { use } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { SectionNav } from '@/components/shell/section-nav'
import { Brain, ClipboardList, FileStack, Gauge, SlidersHorizontal, Users } from 'lucide-react'
import { DocumentsSettings } from '@/features/projects/components/settings/documents-settings'
import { GeneralSettings } from '@/features/projects/components/settings/general-settings'
import { MembersSettings } from '@/features/projects/components/settings/members-settings'
import { MemorySettings } from '@/features/projects/components/settings/memory-settings'
import { ProfileSettings } from '@/features/projects/components/settings/profile-settings'
import {
  UsageSettings,
  type ProjectUsageView,
} from '@/features/projects/components/settings/usage-settings'
import {
  visibleSettingsSections,
  type ProjectSettingsSectionKey,
} from '@/features/projects/lib/settings-sections'
import { getApplicableStandards } from '@/lib/oib/applicable-standards'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { FIXTURE_PROJECT_ID, FIXTURE_USER_ID, HISTORY } from '../../_fixtures/upload-batches'

const PROJECT_ID = FIXTURE_PROJECT_ID

const fact = (value: string | number) => ({
  value,
  confidence: 'confirmed' as const,
  source: 'onboarding' as const,
  updatedAt: '2026-03-01T09:00:00Z',
})

const PROFILE: ProjectProfile = {
  facts: {
    hauptnutzung: fact('wohnen'),
    gebaeudeklasse: fact('GK4'),
    fluchtniveau: fact('<=11m'),
    geschosse_unterirdisch: fact(1),
  },
  goals: {},
  unknowns: ['Stellplatznachweis'],
  assumptions: {
    energieausweis: {
      value: 'Neubau nach OIB-RL 6',
      status: 'unconfirmed',
      reason: 'Neubau ohne Angabe zur Energieeffizienz',
      source: 'agent_suggested',
      updatedAt: '2026-03-02T09:00:00Z',
    },
  },
}

const PROFILE_DATA = {
  id: PROJECT_ID,
  profile: PROFILE,
  profileDisplay: {
    title: 'Wohnbau Mariahilf',
    summary:
      'Wohngebäude der Gebäudeklasse 4 in Wien Mariahilf mit oberstem Fluchtniveau bei 9,8 m; Neubau, offene Bauweise, 14 Wohneinheiten.',
    summaryLocale: 'de',
  },
  applicableStandards: getApplicableStandards(PROFILE),
  briefComplete: true,
}

const usage = (blocked: string | null): ProjectUsageView => ({
  unit: 'credit',
  day: { amount: blocked ? 40 : 12.4, events: 18 },
  month: { amount: 286.5, events: 412 },
  perModel: [
    { model: 'anthropic/claude-sonnet-5-5', month: { amount: 214.2, events: 280 } },
    { model: 'openai/text-embedding-3-large', month: { amount: 51.8, events: 96 } },
    { model: 'anthropic/claude-haiku-5-5', month: { amount: 20.5, events: 36 } },
  ],
  projectLimit: { dailyLimit: 40, monthlyLimit: 600 },
  orgLimit: { dailyLimit: 200, monthlyLimit: 4000 },
  blockedScope:
    blocked === 'project' ? 'project' : blocked === 'organization' ? 'organization' : null,
})

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __settingsShim?: boolean }
  if (!w.__settingsShim) {
    w.__settingsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `/api/projects/${PROJECT_ID}/uploads`) return Response.json({ uploads: HISTORY })
      if (/\/api\/projects\/[^/]+\/members$/.test(url)) {
        return Response.json({
          members: [
            {
              assignmentId: 'm1',
              organizationMembershipId: 'me',
              name: 'Anna Berger',
              email: 'anna@buero.at',
              role: 'project-admin',
            },
            {
              assignmentId: 'm2',
              organizationMembershipId: 'u2',
              name: 'Markus Klein',
              email: 'markus@buero.at',
              role: 'project-editor',
            },
          ],
        })
      }
      if (/\/api\/projects\/[^/]+\/memory$/.test(url)) {
        return Response.json({
          items: [
            {
              id: 'mem1',
              content: 'Bauherr bevorzugt Sichtbeton an der Nordfassade.',
              kind: 'preference',
              scope: 'project',
              confidence: 'high',
              createdAt: '2026-05-02T10:00:00Z',
              updatedAt: '2026-05-02T10:00:00Z',
              lastReferencedAt: null,
              pinned: true,
            },
          ],
        })
      }
      // Summary auto-generate / profile patches — no-op for the preview.
      if (/\/(generate-summary|profile\/patches)$/.test(url)) return Response.json({})
      return real(input, init)
    }
  }
}

const ICONS = {
  general: SlidersHorizontal,
  profile: ClipboardList,
  members: Users,
  memory: Brain,
  usage: Gauge,
  documents: FileStack,
} as const

const LABELS: Record<ProjectSettingsSectionKey, string> = {
  general: 'General',
  profile: 'Project profile',
  members: 'Members',
  memory: 'Memory',
  usage: 'Usage & budget',
  documents: 'Documents & index',
}

export default function SettingsDevPage({
  params,
}: {
  params: Promise<{ section?: string[] }>
}): JSX.Element {
  const { section } = use(params)
  const search = useSearchParams()
  if (process.env.NODE_ENV !== 'development') notFound()

  const admin = search.get('as') !== 'viewer'
  const suffix = admin ? '' : '?as=viewer'
  const sections = visibleSettingsSections({ manageMembers: admin, manageBudget: admin })
  const current = (section?.[0] ?? 'general') as ProjectSettingsSectionKey
  if (!sections.includes(current)) notFound()

  const items = sections.map((key) => ({
    key,
    href: `/dev/settings${key === 'general' ? '' : `/${key}`}${suffix}`,
    icon: ICONS[key],
    label: LABELS[key],
  }))

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8" data-testid="settings-preview">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <div className="lg:w-52 lg:shrink-0">
          <SectionNav
            label="Project settings"
            items={items}
            rootHref="/dev/settings"
            pillId="dev-settings-pill"
          />
        </div>
        <div className="min-w-0 flex-1">
          {current === 'general' && (
            <GeneralSettings
              projectId={PROJECT_ID}
              projectName="Wohnbau Mariahilf"
              createdAt="2026-03-01T09:00:00Z"
              documentCount={128}
              totalFileSize={2_480_000_000}
              canManage={admin}
            />
          )}
          {current === 'profile' && <ProfileSettings data={PROFILE_DATA} canEdit={admin} />}
          {current === 'members' && (
            <MembersSettings projectId={PROJECT_ID} currentMembershipId="me" />
          )}
          {current === 'memory' && <MemorySettings projectId={PROJECT_ID} canWrite={admin} />}
          {current === 'usage' && (
            <UsageSettings
              projectId={PROJECT_ID}
              usage={usage(search.get('blocked'))}
              canEditLimit={admin}
            />
          )}
          {current === 'documents' && (
            <DocumentsSettings
              projectId={PROJECT_ID}
              currentUserId={FIXTURE_USER_ID}
              canReindex={admin}
              showKnowledgeLink
            />
          )}
        </div>
      </div>
    </main>
  )
}
