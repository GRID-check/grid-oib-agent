'use client'

/**
 * Dev preview for restricted project memory (ADR-0084, "Memory from a
 * restricted turn is restricted memory"). Renders the REAL `ProjectMemoryPanel`
 * twice, with fixtures and no backend:
 *
 *   - as a member cleared for „Verträge": the open notes and the restricted
 *     note, which carries the lock badge naming its folder;
 *   - as a member who is not: the open notes only. The API leaves the
 *     restricted note out entirely, so nothing on this side hints at it.
 *
 * A module-scope fetch shim (browser + dev only) answers the two listings the
 * way `GET /api/projects/[id]/memory` does for each reader. Not linked from
 * anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { ProjectMemoryPanel } from '@/features/projects/components/project-memory-panel'

const CLEARED = 'dev-memory-cleared'
const UNCLEARED = 'dev-memory-uncleared'
/** The source folder of the restricted note (ADR-0085). */
const RESTRICTED_FOLDER = '01234567-89ab-4cde-8f01-23456789abcd'

function item(id: string, kind: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    scope: 'project',
    projectId: CLEARED,
    organizationId: 'org_dev',
    kind,
    content,
    status: 'active',
    confidence: 'high',
    verification: 'unverified',
    provenanceType: 'distillation',
    sourceConversationId: null,
    supersedesId: null,
    conflictsWithId: null,
    restrictedFolderIds: null,
    salience: 0.5,
    pinned: false,
    createdBy: null,
    lastReferencedAt: null,
    recallCount: 0,
    embedding: null,
    embeddingModel: null,
    embeddedAt: null,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-02T08:30:00Z',
    ...overrides,
  }
}

const OPEN = [
  item('m-open-1', 'decision', 'Die Bauherrschaft hat sich für ein extensiv begrüntes Flachdach entschieden.'),
  item('m-open-2', 'constraint', 'Gebäudeklasse 4 nach OIB-RL 2, Fluchtniveau 10,4 m.'),
]
const RESTRICTED = item(
  'm-restricted-1',
  'derived_fact',
  'Das Honorar für die Leistungsphasen 5–8 ist mit 184.000 € netto pauschal vereinbart.',
  { restrictedFolderIds: [RESTRICTED_FOLDER], restrictedFolderNames: ['Verträge'] }
)

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __restrictedMemoryShim?: boolean }
  if (!w.__restrictedMemoryShim) {
    w.__restrictedMemoryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `/api/projects/${CLEARED}/memory`) return Response.json({ items: [RESTRICTED, ...OPEN] })
      if (url === `/api/projects/${UNCLEARED}/memory`) return Response.json({ items: OPEN })
      return real(input, init)
    }
  }
}

export default function RestrictedMemoryDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <main className="mx-auto grid max-w-6xl gap-8 p-4 sm:p-8 lg:grid-cols-2" data-testid="restricted-memory-preview">
      <section className="space-y-3">
        <h1 className="text-lg font-semibold">Freigegeben für „Verträge“</h1>
        <ProjectMemoryPanel projectId={CLEARED} />
      </section>
      <section className="space-y-3">
        <h1 className="text-lg font-semibold">Nicht freigegeben</h1>
        <ProjectMemoryPanel projectId={UNCLEARED} />
      </section>
    </main>
  )
}
