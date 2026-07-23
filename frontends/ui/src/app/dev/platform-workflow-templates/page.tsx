'use client'

/**
 * Dev preview for the platform WorkflowTemplates manager (ADR-0027). Renders the
 * REAL manager card with fixture data so the list — published + draft badges,
 * provenance chips, cadence hints, and the JSON-import dropzone — can be
 * reviewed and screenshotted without a backend. A module-scope fetch shim
 * (browser + dev only) serves the platform templates list. Not linked from
 * anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { WorkflowTemplates } from '@/features/platform/components/workflow-templates'

const CONTENT = (name: string, category: string, objective: string) => ({
  de: { name, description: `${name} – Kurzbeschreibung.`, category, definition: { version: 1, blocks: { objective } } },
  en: { name, description: `${name} – short description.`, category, definition: { version: 1, blocks: { objective } } },
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
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformTemplatesShim?: boolean }
  if (!w.__platformTemplatesShim) {
    w.__platformTemplatesShim = true
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

export default function PlatformWorkflowTemplatesDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-lg font-semibold">Platform — Workflow templates manager</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: author, import, publish and delete templates surfaced in every org’s gallery.
        </p>
      </div>
      <WorkflowTemplates />
    </main>
  )
}
