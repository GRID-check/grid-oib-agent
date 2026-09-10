'use client'

/**
 * Sammlungen verwalten — dev preview (visual/registry.mjs → `project-sets`).
 * Not linked anywhere and 404s outside development.
 *
 * What this capture is evidence of: a Sammlung is a LABEL over projects and the
 * SERVER decides who may change it. So the list is photographed with both kinds
 * of row side by side — one this reader owns, with rename and delete, and one
 * belonging to the office, with neither — because "the controls are missing" and
 * "there are no controls here" have to be distinguishable at a glance, and the
 * second row is the one a screenshot review would otherwise never see.
 *
 * Two variants:
 *
 * - default — the list: three Sammlungen, one of them read-only, the create
 *   control at the foot, and the sentence that says a Sammlung grants nobody
 *   anything.
 * - `?variant=detail` — one Sammlung open: its members with a remove each, and
 *   the add list built from the SAME readable project list the picker uses.
 *
 * The panel renders INLINE rather than inside its `Dialog`, for the reason the
 * scope-tree preview gives: the dialog is `components/ui/dialog.tsx` and is
 * photographed wherever it is already used; what is worth evidence here is the
 * panel's own rows, and a preview that has to drive an overlay open before it
 * can be captured fails on a timing change rather than on a design change.
 *
 * The client is stubbed at `fetch`, so this route needs no backend and the
 * capture is deterministic.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { I18nProvider } from '@/i18n'
import { ProjectSetManager } from '@/features/layout/components/scope/ProjectSetManager'

const SETS = [
  {
    id: 's-b3',
    name: 'Bezirk 3',
    description: 'Alle Projekte im dritten Bezirk',
    createdBy: 'u-me',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    projectCount: 3,
    editable: true,
  },
  {
    id: 's-2026',
    name: 'Einreichungen 2026',
    description: null,
    createdBy: 'u-me',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    projectCount: 5,
    editable: true,
  },
  {
    id: 's-wien',
    name: 'Stadt Wien',
    description: 'Vom Büro gepflegt',
    createdBy: 'u-other',
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    projectCount: 2,
    editable: false,
  },
]

const PROJECTS = [
  { id: 'p-see', name: 'Seestadt Nord' },
  { id: 'p-ros', name: 'Rosenhügel' },
  { id: 'p-lend', name: 'Lendplatz Höfe' },
  { id: 'p-donau', name: 'Donaufeld Bauteil C' },
]

const DETAIL = {
  ...SETS[0],
  projects: [PROJECTS[0], PROJECTS[1], PROJECTS[2]],
}

/**
 * The detail pane reads its members through the client, which is the one thing
 * on this panel a fixture prop cannot supply — the members ARE the pane. The
 * shim is module scope and guarded, the pattern `/dev/budget-usage` already
 * uses, so it installs once and never during a render.
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __projectSetsShim?: boolean }
  if (!w.__projectSetsShim) {
    w.__projectSetsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/workspace/project-sets/')) return Response.json({ set: DETAIL })
      if (url.startsWith('/api/workspace/project-sets')) return Response.json({ sets: SETS })
      if (url.startsWith('/api/projects')) return Response.json(PROJECTS)
      return real(input, init)
    }
  }
}

const ProjectSetsPreview = (): React.ReactElement => {
  const detail = useSearchParams()?.get('variant') === 'detail'

  return (
    <main className="bg-background flex min-h-dvh items-start justify-center p-6">
      <div className="bg-popover w-full max-w-lg rounded-xl border p-4 shadow-md">
        <ProjectSetManager
          sets={SETS}
          projects={PROJECTS}
          initialSetId={detail ? DETAIL.id : undefined}
        />
      </div>
    </main>
  )
}

export default function ProjectSetsPreviewPage(): React.ReactElement {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={null}>
        <ProjectSetsPreview />
      </Suspense>
    </I18nProvider>
  )
}
