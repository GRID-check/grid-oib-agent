'use client'

/**
 * Dev preview for the org-facing Workflows template gallery (ADR-0027). Renders
 * the REAL TemplateCards with a fetch shim serving PUBLISHED platform templates,
 * so the merged gallery — built-in templates followed by the platform-published
 * ones — can be reviewed and screenshotted without a backend. Not linked from
 * anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { TemplateCards } from '@/features/workflows/components/template-cards'

const CONTENT = (name: string, category: string, objective: string) => ({
  de: { name, description: `${name} – Kurzbeschreibung.`, category, definition: { version: 1, blocks: { objective } } },
  en: { name, description: `${name} – short description.`, category, definition: { version: 1, blocks: { objective } } },
})

const GALLERY = [
  {
    id: 'tpl-regwatch',
    provenance: 'law',
    dataSources: ['ris', 'web_search'],
    scheduleCron: '0 6 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Energieausweis-Update', 'Recht', 'Änderungen der Energieausweispflicht überwachen.'),
  },
  {
    id: 'tpl-office',
    provenance: 'office',
    dataSources: [],
    scheduleCron: null,
    scheduleTimezone: 'Europe/Vienna',
    content: CONTENT('Büro-Standardprüfung', 'Büro', 'Interne Bürostandards gegen ein Projekt prüfen.'),
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __galleryTemplatesShim?: boolean }
  if (!w.__galleryTemplatesShim) {
    w.__galleryTemplatesShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/workflow-templates')) {
        return Response.json({ templates: GALLERY })
      }
      return real(input, init)
    }
  }
}

export default function WorkflowTemplateGalleryDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-lg font-semibold">Workflows — template gallery (built-in + platform)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The gallery every org sees: GRID built-in templates followed by the platform-published ones.
        </p>
      </div>
      <TemplateCards onUse={() => {}} />
    </main>
  )
}
