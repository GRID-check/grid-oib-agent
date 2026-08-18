'use client'

/**
 * The REAL file-ask split, mounted end to end.
 *
 * Why this exists, and why it is not `/dev/file-chat-dock`. That preview hand-
 * rolls the peek: a literal `<aside>` with its own header markup, and
 * `FilePreviewPane` dropped inside it. It is a picture of the intended result,
 * so it stays green no matter what `FilePreviewHost` / `FilePreviewSplit` /
 * `useFileAskSplit` actually do. The pane has always rendered; what broke is the
 * SPLIT AROUND IT, and nothing in `/dev` ever exercised that.
 *
 * This route mounts `FilePreviewBridge` — the same component the project layout
 * mounts — around a stand-in for the chat column, so the resizable group, the
 * `useLayoutEffect` that resizes the file panel, and the height chain from the
 * shell's `<main>` down to the pane are all under test.
 *
 * ── The `/chat` in the path is load-bearing ──────────────────────────────────
 * `useFileAskSplit()` gates on `usePathname()?.includes('/chat')`, so a preview
 * at `/dev/file-ask-split` would render the collapsed (no-split) branch and look
 * "fine" while proving nothing. The route is therefore nested one level so its
 * URL contains `/chat`, exactly as `/app/projects/[id]/chat` does.
 *
 * ── The shell's `<main>` is reproduced, not approximated ─────────────────────
 * The wrapper below copies `app/(shell)/layout.tsx`'s frame and `<main>`
 * verbatim (`h-dvh overflow-hidden` row → `min-h-0 flex-1 overflow-y-auto`
 * column). That pairing is the thing under suspicion: the pre-restructure
 * `<main>` was `flex-1 flex-col overflow-hidden`, and a percentage height inside
 * a SCROLL container resolves differently from one inside a clipped box.
 * Substituting a simpler wrapper here would silently fix the bug in the preview.
 *
 * Variants via `?variant=`:
 *   - default    — file open in `peek`, the split the reader should get.
 *   - `hidden`   — same file, peek dismissed: chat must reclaim the full row.
 */

import { useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { FilePreviewBridge } from '@/features/documents/components/file-preview-host'
import { MainLayout } from '@/features/layout/components/MainLayout'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

const FILE: FileItem = {
  id: 'doc-brandschutz',
  filename: 'Brandschutzplan_EG.pdf',
  displayName: null,
  fileSize: 2_458_112,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-04-02T09:00:00.000Z',
  errorMessage: null,
  summary:
    'Brandschutzkonzept Erdgeschoss, Fluchtwege und Feuerwiderstand der tragenden Wände.',
  pageCount: 12,
  chunkCount: 48,
  contentTypes: ['text', 'drawing'],
  tags: ['Brandschutz'],
}

// Module scope, not an effect — `FilePreviewSplit` sizes its file panel in a
// `useLayoutEffect` that runs BEFORE this page's own effects would, so a seed
// deferred to a component effect lands one commit too late and the panel starts
// collapsed. Same reason `/dev/app-rail` seeds its storage key at module scope.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const hidden = new URLSearchParams(window.location.search).get('variant') === 'hidden'
  useFilePreviewStore.setState({
    file: FILE,
    mode: 'peek',
    hidden,
    context: { projectId: 'proj-1', projectName: 'Seestadt Baufeld', scope: 'files' },
  })
}

export default function FileAskSplitPreview(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      {/* Copied from app/(shell)/layout.tsx — see the header note. */}
      <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row">
        <div
          className="bg-sidebar hidden w-[236px] shrink-0 border-r border-border md:block"
          aria-hidden
        />
        <main className="bg-background relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none">
          <div data-testid="file-ask-split-preview" data-variant={variant} className="contents">
            <FilePreviewBridge>
              {/* The REAL chat surface, not a stand-in. `MainLayout` keeps its
                  own inline width rule for the peek, and that rule is only
                  wrong in combination with the split around it — a stand-in
                  column would have hidden exactly the defect this route is
                  for. Every prop is optional and the stores are empty here, so
                  it renders its signed-out/empty state, which is enough: the
                  subject under test is the width of its column. */}
              <MainLayout />
            </FilePreviewBridge>
          </div>
        </main>
      </div>
    </I18nProvider>
  )
}
