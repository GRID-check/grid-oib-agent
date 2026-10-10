'use client'

/**
 * Dev preview for the closing debrief (docs/roadmap/office-experience.md, step
 * 3): the REAL `ProjectLifecycleCard`, whose close dialog („Ausmisten", ADR-0092) asks
 * with the REAL `ClosingDebrief` inside. Open it with „Projekt abschließen".
 *
 *   - default             — a project admin who may write the memory: two facts
 *                           of the fingerprint open (one of them the derived
 *                           Gebäudeklasse), two decisions to confirm, a
 *                           constraint a person already pinned, and the lesson.
 *   - `?variant=readonly` — a closer without `project:memory:write`: what stays,
 *                           and no control that would change it.
 *   - `?variant=empty`    — nothing recorded yet, and no profile at all.
 *   - `?variant=structure` — a Stützmauer: the class and the construction „trifft
 *                           nicht zu", not missing.
 *
 * A module-scope fetch shim (browser + dev only) answers the memory listing,
 * its two writes and the dialog's „Ausmisten" proposal (nothing to remove), so
 * confirming and recording are live; closing itself is refused, so the preview
 * stays open. Pinned to German, the product's primary
 * language (`docs/ux/visual-screenshots.md`).
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'

import { I18nProvider } from '@/i18n'
import { ProjectLifecycleCard } from '@/features/projects/components/project-lifecycle-card'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'

type Variant = 'default' | 'readonly' | 'empty' | 'structure'
const PROJECT = 'dev-closing-debrief'
const EMPTY = 'dev-closing-debrief-empty'

function item(id: string, kind: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    scope: 'project',
    projectId: PROJECT,
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
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-02T08:30:00Z',
    ...overrides,
  }
}

const MEMORY = [
  item(
    'm-1',
    'decision',
    'Kapselung K₂60 der Holzdecken mit zweilagigen Gipsfaserplatten statt Gipskarton, weil dafür ein Prüfbericht für die Fuge vorlag.'
  ),
  item('m-2', 'constraint', 'Die BH Baden verlangt die Fluchtwegbreiten in jedem Geschoßgrundriss bemaßt.', { pinned: true }),
  item('m-3', 'decision', 'Laubengang statt zweitem Stiegenhaus; Fluchtniveau unter 11\u00a0m gehalten.'),
  item('m-4', 'derived_fact', 'Die Dachlast beträgt 2 kN/m².'),
]

// Built by the intake's own producer, in the shape production stores.
const built = (answers: Record<string, ProjectPrimitiveValue>): ProjectProfile =>
  buildIntakeProfile(answers, projectIntakeDefinitionV1, { bauwerke: [{ id: 'bw1', name: 'Haupthaus' }] })

const PROFILE = built({
  A2_country: 'at',
  A2_land: 'niederoesterreich',
  'C1@bw1': 'gebaeude',
  'C10@bw1': ['holzbau', 'stahlbeton'],
  'D0@bw1': ['wohnen'],
})

/** A Stützmauer: no Gebäudeklasse, no Bauweise to ask for. */
const STRUCTURE = built({ A2_country: 'at', A2_land: 'tirol', A5: ['neubau'], 'C1@bw1': 'sonstig' })

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __closingDebriefShim?: boolean }
  if (!w.__closingDebriefShim) {
    w.__closingDebriefShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `/api/projects/${EMPTY}/memory`) return Response.json({ items: [] })
      if (url === `/api/projects/${PROJECT}/memory` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { content: string }
        return Response.json({ item: item(`m-${Date.now()}`, 'decision', body.content, { provenanceType: 'user' }) }, { status: 201 })
      }
      if (url === `/api/projects/${PROJECT}/memory`) return Response.json({ items: MEMORY })
      const patched = url.startsWith(`/api/projects/${PROJECT}/memory/`) && init?.method === 'PATCH'
      if (patched) {
        const found = MEMORY.find((entry) => url.endsWith(`/${entry.id}`))
        return Response.json({ item: { ...found, verification: 'user_confirmed' } })
      }
      // The „Ausmisten" proposal the close dialog asks for first (ADR-0092): nothing to remove.
      if (url.endsWith('/cleanup/proposal')) return Response.json({ items: [], considered: 0, aiUsed: false, aiError: null })
      if (url.endsWith('/status')) return new Response('{}', { status: 409 })
      return real(input, init)
    }
  }
}

export default function ClosingDebriefDevPage(): JSX.Element {
  const [variant, setVariant] = useState<Variant>('default')
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('variant')
    if (value === 'readonly' || value === 'empty' || value === 'structure') setVariant(value)
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto max-w-3xl p-4 sm:p-8" data-testid="closing-debrief-preview">
        <ProjectLifecycleCard
          key={variant}
          projectId={variant === 'empty' ? EMPTY : PROJECT}
          status="active"
          closedAt={null}
          profile={variant === 'empty' ? null : variant === 'structure' ? STRUCTURE : PROFILE}
          startedOn={variant === 'empty' ? null : '2023-04'}
          canWriteMemory={variant !== 'readonly'}
        />
      </main>
    </I18nProvider>
  )
}
