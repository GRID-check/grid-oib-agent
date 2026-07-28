'use client'

/**
 * Dev preview for the rebuilt platform → workflows section (ADR-0027).
 *
 * Renders the REAL <WorkflowTemplates> on fixture data so the primitives shape —
 * SectionCard chrome, the DataToolbar with its published/draft filter, and the
 * template table with its provenance, data-source, cadence and publish columns —
 * can be reviewed and screenshotted without a backend. A module-scope fetch shim
 * (browser + dev only) serves the platform templates list; the authoring Sheet
 * and the import dialog are reachable from the header actions.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { WorkflowTemplates } from '@/features/platform/components/workflow-templates'

const CONTENT = (name: string, category: string, objective: string) => ({
  de: {
    name,
    description: `${name} – Kurzbeschreibung.`,
    category,
    definition: { version: 1, blocks: { objective } },
  },
  en: {
    name,
    description: `${name} – short description.`,
    category,
    definition: { version: 1, blocks: { objective } },
  },
})

const TEMPLATES = [
  {
    id: 'tpl-regwatch',
    provenance: 'law',
    dataSources: ['ris', 'web_search'],
    agentType: 'deep_researcher',
    scheduleCron: '0 6 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Richtlinien-Monitoring', 'Recht', 'Neue OIB-Richtlinien überwachen.'),
    published: true,
    sortOrder: 0,
    createdByEmail: 'owner@grid.example',
    createdAt: '2026-07-10T09:00:00Z',
    updatedAt: '2026-07-20T09:00:00Z',
  },
  {
    id: 'tpl-precheck',
    provenance: 'law',
    dataSources: ['ris'],
    agentType: 'deep_researcher',
    scheduleCron: null,
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Vorprüfung Einreichung', 'Compliance', 'Einreichanforderungen prüfen.'),
    published: true,
    sortOrder: 1,
    createdByEmail: 'owner@grid.example',
    createdAt: '2026-07-11T09:00:00Z',
    updatedAt: '2026-07-19T09:00:00Z',
  },
  {
    id: 'tpl-draft',
    provenance: 'project',
    dataSources: [],
    agentType: 'deep_researcher',
    scheduleCron: '0 6 1 * *',
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Dokumentations-Check', 'Projekt', 'Projektunterlagen auf Lücken prüfen.'),
    published: false,
    sortOrder: 2,
    createdByEmail: 'owner@grid.example',
    createdAt: '2026-07-18T09:00:00Z',
    updatedAt: '2026-07-18T09:00:00Z',
  },
  {
    id: 'tpl-energy',
    provenance: 'office',
    dataSources: ['ris', 'web_search', 'knowledge_layer'],
    agentType: 'deep_researcher',
    scheduleCron: '17 4 * * 2',
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Energieausweis-Radar', 'Energie', 'Änderungen an Energieausweis-Vorgaben verfolgen.'),
    published: false,
    sortOrder: 3,
    createdByEmail: 'owner@grid.example',
    createdAt: '2026-07-21T09:00:00Z',
    updatedAt: '2026-07-25T09:00:00Z',
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformWorkflowsShim?: boolean }
  if (!w.__platformWorkflowsShim) {
    w.__platformWorkflowsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/workflow-templates')) {
        return Response.json({ templates: TEMPLATES })
      }
      return real(input, init)
    }
  }
}

export default function PlatformWorkflowsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-8" data-testid="platform-workflows-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Workflow templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface on the shared admin primitives: search and filter the published templates,
          toggle publish inline, and author or import one from the header actions.
        </p>
      </div>
      <WorkflowTemplates />
    </main>
  )
}
