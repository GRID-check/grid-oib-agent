'use client'

/**
 * The Wissensbasis — dev preview (visual/registry.mjs → `scope-tree`).
 * Not linked anywhere and 404s outside development.
 *
 * What this capture is evidence of: the hierarchy is FIXED and the reader can
 * see the hole in it. Every variant renders all six levels in the same order,
 * and what differs between them is which levels are `immer`, which are
 * `ausgeschlossen` with a reason, and which are `nicht verfügbar` with a closed
 * door — the four Datenbasis words, in words, beside the colour and the glyph
 * (`workspace-chat-ui.md` §4, §8).
 *
 * Three variants, one per state the design has to be checked in:
 *
 * - `workspace` — the Büro with two projects in view, the remove control on
 *   each, and "+ Projekt einblenden" below them.
 * - `project` — a project chat: the register `nicht verfügbar` (it does not
 *   exist outside the Büro), one locked project, and "Im Büro fragen →" at the
 *   foot, which is what replaced the disabled "Alle Projekte · Bald verfügbar"
 *   row this design deleted.
 * - `capped` — five projects in view: the add row is gone, its reason is
 *   visible in its place, and the cap's offer is the one path that reads more
 *   than the cap allows.
 *
 * Since ADR-0055 the sixth level is „Gedächtnis", between Projekt and Diese
 * Unterhaltung. It is `immer` and carries no switch — the panel is where a note
 * is removed — and it states `3 von 47` with the omission the digest reported.
 *
 * The tree renders INLINE rather than inside its `Popover`. The popover is
 * `components/ui/popover.tsx` and is photographed wherever it is already used;
 * what is worth evidence here is the tree's own rows, and a preview that has to
 * drive an overlay open before it can be captured is a preview that fails on a
 * timing change rather than on a design change.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { I18nProvider } from '@/i18n'
import { ScopeChip } from '@/features/layout/components/scope/ScopeChip'
import { ScopeTree } from '@/features/layout/components/scope/ScopeTree'
import { buildScopeLevels } from '@/features/layout/components/scope/scope-tree-model'

const CAP = 5

const TWO_PROJECTS = [
  { projectId: 'p-see', projectName: 'Seestadt Nord', mountedBy: 'user' as const },
  { projectId: 'p-ros', projectName: 'Rosenhügel', mountedBy: 'agent' as const },
]

const FIVE_PROJECTS = [
  ...TWO_PROJECTS,
  { projectId: 'p-lend', projectName: 'Lendplatz Höfe', mountedBy: 'user' as const },
  { projectId: 'p-donau', projectName: 'Donaufeld Bauteil C', mountedBy: 'user' as const },
  { projectId: 'p-alt', projectName: 'Althanquartier', mountedBy: 'agent' as const },
]

const noop = (): void => {}

const ScopeTreePreview = (): React.ReactElement => {
  const variant = useSearchParams()?.get('variant') ?? 'workspace'
  const isProject = variant === 'project'
  const capped = variant === 'capped'
  const mounted = capped ? FIVE_PROJECTS : TWO_PROJECTS

  const levels = buildScopeLevels({
    scope: isProject ? 'project' : 'workspace',
    projectName: isProject ? 'Seestadt Nord' : undefined,
    mounted: isProject ? [] : mounted,
    // One attached file, so the conversation level is `immer` in the Büro
    // variants and the empty case is not the only one ever photographed.
    sessionAttachmentCount: isProject ? 0 : 1,
    canMount: !capped,
    // The level ADR-0055 added: read on every turn, stating how much of itself
    // this turn saw. The omission is the number the digest gives the MODEL,
    // said to the reader too — which is the whole point of the row.
    memory: { carried: 3, total: 47, omitted: 44 },
  })

  return (
    <main className="bg-background flex min-h-dvh items-start justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-3">
        {/* The chip above the tree it opens: below `sm` the label is gone and
            the glyph is the only carrier of scope, which is why the two are
            photographed together. */}
        <ScopeChip
          variant={isProject ? 'project' : 'workspace'}
          label={isProject ? 'Seestadt Nord' : 'Büro'}
          mountedCount={isProject ? 0 : mounted.length}
        />
        <div className="bg-popover rounded-xl border p-2 shadow-md">
          <ScopeTree
            levels={levels}
            cap={CAP}
            onMount={noop}
            onUnmount={noop}
            onDeepResearch={noop}
            onOpenMemory={noop}
            onAskInWorkspace={isProject ? noop : undefined}
          />
        </div>
      </div>
    </main>
  )
}

export default function ScopeTreePreviewPage(): React.ReactElement {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={null}>
        <ScopeTreePreview />
      </Suspense>
    </I18nProvider>
  )
}
