'use client'

/**
 * Dev preview for the Project Settings screen so its section chrome (headings,
 * cards, danger zone) can be reviewed/screenshotted without a backend. A
 * module-scope fetch shim serves the members/memory lists the child panels load.
 * 404s outside development.
 */

import { notFound } from 'next/navigation'
import { ProjectSettings } from '@/features/projects/components/project-settings'
import type { ProjectOverviewData } from '@/features/projects/types'

const DATA: ProjectOverviewData = {
  id: 'proj-demo',
  name: 'Wohnbau Mariahilf',
  collectionName: 'proj_demo',
  createdAt: '2026-03-01T09:00:00Z',
  profileDisplay: {
    summary:
      'Wohngebäude der Gebäudeklasse 4 in Wien Mariahilf mit oberstem Fluchtniveau bei 9,8 m; Neubau, offene Bauweise, 14 Wohneinheiten.',
    summaryLocale: 'en',
    keyFacts: [
      { label: 'Gebäudeklasse', value: 'GK 4' },
      { label: 'Fluchtniveau', value: '9,8 m' },
      { label: 'Bestand/Neubau', value: 'Neubau' },
      { label: 'Wohneinheiten', value: '14' },
    ],
    missingInfo: ['Stellplatznachweis', 'Energieausweis'],
  },
  profile: null,
  applicableStandards: [],
  briefComplete: false,
  documentCount: 12,
  totalFileSize: 48_000_000,
  recentDocuments: [],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __settingsShim?: boolean }
  if (!w.__settingsShim) {
    w.__settingsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

export default function SettingsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return <ProjectSettings data={DATA} canManageProject showKnowledgeLink currentMembershipId="me" />
}
