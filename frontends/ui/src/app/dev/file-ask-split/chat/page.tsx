'use client'

/**
 * The REAL file-ask split, mounted end to end.
 *
 * Why this exists, and why it is not `/dev/file-chat-dock`. That preview hand-
 * rolls the peek: a literal `<aside>` with its own header markup, and
 * `FilePreviewPane` dropped inside it. It is a picture of the intended result,
 * so it stays green no matter what `FilePreviewHost` / `FilePreviewSplit` /
 * `useFilePeekBesideChat` actually do. The pane has always rendered; what broke is the
 * SPLIT AROUND IT, and nothing in `/dev` ever exercised that.
 *
 * This route mounts `FilePreviewBridge` — the same component the project layout
 * mounts — around a stand-in for the chat column, so the resizable group, the
 * `useLayoutEffect` that resizes the file panel, and the height chain from the
 * shell's `<main>` down to the pane are all under test.
 *
 * ── The `/chat` in the path is load-bearing ──────────────────────────────────
 * `useFilePeekBesideChat()` gates on `usePathname()?.includes('/chat')`, so a preview
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
 * ── `arrive` is the variant that matters ────────────────────────────────────
 * `default` mounts with the peek ALREADY open, which is not a journey anyone
 * takes. The real one is Ask Piloti from a file: the reader is on `/files`, so
 * `FilePreviewBridge` — which lives in the PROJECT layout and therefore mounts
 * once for the whole project, not per section — mounts with `split` FALSE. Its
 * file panel is created with `defaultSize={0}`, `minSize={0}` and `maxSize={0}`,
 * and only later, when the pathname reaches `/chat`, does `split` flip and a
 * `useLayoutEffect` try to `resize()` it back open. `defaultSize` is a
 * mount-time value, so it never gets a second chance. That cold-mount-then-flip
 * is the transition Ask Piloti always takes and the one nothing covered.
 *
 * Variants via `?variant=`:
 *   - default    — file open in `peek`, the split the reader should get.
 *   - `hidden`   — same file, peek dismissed: chat must reclaim the full row.
 *   - `arrive`   — mounts with NO file, exactly as `/files` does, then the
 *                  button opens the peek. This is the Ask Piloti path.
 *   - `indexing` — the same peek on a document that is still being read. The
 *                  status the modal has always carried under the name, on the
 *                  one surface whose entire reason is "this is what you are
 *                  asking about" — where a file the agent cannot cite yet used
 *                  to look exactly like one it can.
 *   - `failed`   — indexing failed. The one state on this surface that does not
 *                  resolve itself, so it is the one that carries a way out.
 *   - `wide`     — the peek at a width the reader dragged it to and the split
 *                  remembered. Until the seam was fixed this state was
 *                  unreachable: the drag fought back after ~20px and the old
 *                  560px cap stood well short of it. It is the state the
 *                  document is actually read in, so the two columns' behaviour
 *                  at that ratio needs evidence.
 */

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { FilePreviewBridge } from '@/features/documents/components/file-preview-host'
import { MainLayout } from '@/features/layout/components/MainLayout'
import {
  FILE_PEEK_WIDTH_STORAGE_KEY,
  useFilePreviewStore,
} from '@/features/documents/stores/file-preview-store'
import { FLOOR_PLAN_DATA_URI } from '../../_fixtures/floor-plan'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

const FILE: FileItem = {
  id: 'doc-brandschutz',
  filename: 'Grundriss_EG_Baufeld_D12.svg',
  displayName: null,
  fileSize: 2_458_112,
  contentType: 'image/svg+xml',
  status: 'ready',
  folderId: null,
  createdAt: '2026-04-02T09:00:00.000Z',
  errorMessage: null,
  summary:
    'Grundriss des Erdgeschosses, Baufeld D12, Maßstab 1:100. Zeigt vier Nutzungseinheiten (Foyer, Büro 01, Technik, Lager) mit Flächenangaben, die beiden voneinander unabhängigen Fluchtwege und die Feuerwiderstandsklasse REI 90 der tragenden Wände. Stand 04/2026.',
  pageCount: 12,
  chunkCount: 48,
  contentTypes: ['text', 'drawing'],
  tags: ['Brandschutz'],
}

const CONTEXT = { projectId: 'proj-1', projectName: 'Seestadt Baufeld', scope: 'files' } as const

/**
 * The preview endpoint, answered locally.
 *
 * `/dev` has no backend, so `/api/documents/:id/preview` 403s and every shot of
 * this route was taken against the pane's FAILURE state — a grey box where the
 * drawing should be. The seams this route exists to review (the ground under
 * the document, the card's shadow, what the well does as the pane is dragged
 * from 280px to 960px) cannot be judged against an error message. Module scope
 * for the same reason as the storage seeds below: the pane fetches in an effect
 * that runs before this page's own would.
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const realFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/preview')) {
      return Promise.resolve(
        new Response(JSON.stringify({ url: FLOOR_PLAN_DATA_URI }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof window.fetch
}

// Module scope, not an effect — `FilePreviewSplit` sizes its file panel in a
// `useLayoutEffect` that runs BEFORE this page's own effects would, so a seed
// deferred to a component effect lands one commit too late and the panel starts
// collapsed. Same reason `/dev/app-rail` seeds its storage key at module scope.
//
// `arrive` deliberately seeds NOTHING. See the header note: that variant is the
// real journey, where the split is mounted cold and only flips later.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const seed = new URLSearchParams(window.location.search).get('variant') ?? 'default'
  // The remembered width is read from storage by the split's own layout effect,
  // so seeding it here is seeding the same input a returning reader arrives
  // with. Cleared for every other variant, or a `wide` run would leave the
  // default shot wide on the next capture.
  try {
    if (seed === 'wide') window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, '720')
    else window.localStorage.removeItem(FILE_PEEK_WIDTH_STORAGE_KEY)
  } catch {
    // Storage unavailable — the preview still renders, at the default width.
  }
  if (seed !== 'arrive') {
    useFilePreviewStore.setState({
      file:
        seed === 'indexing'
          ? { ...FILE, status: 'processing' }
          : seed === 'failed'
            ? { ...FILE, status: 'failed', errorMessage: 'Seite 3: Text-Layer konnte nicht gelesen werden.' }
            : FILE,
      mode: 'peek',
      hidden: seed === 'hidden',
      context: CONTEXT,
    })
  } else {
    useFilePreviewStore.setState({ file: null, mode: 'modal', hidden: false, context: CONTEXT })
  }
}

export default function FileAskSplitPreview(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'

  // `arrive` drives itself, so the screenshot harness (which can navigate but
  // not click) captures the post-arrival state. A plain `useEffect` is the
  // point, not a shortcut: it runs AFTER the split has mounted and after its
  // own `useLayoutEffect` has already collapsed the panel — precisely the
  // ordering the real navigation produces, and precisely what a mount-time seed
  // would paper over.
  useEffect(() => {
    if (variant !== 'arrive') return
    useFilePreviewStore.getState().open(FILE, 'peek', CONTEXT)
  }, [variant])

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
              <>
                {/* Drives the `arrive` variant the way Ask Piloti does: the
                    peek is opened AFTER the split has already mounted cold. */}
                <button
                  type="button"
                  data-testid="open-peek"
                  className="sr-only"
                  onClick={() => useFilePreviewStore.getState().open(FILE, 'peek', CONTEXT)}
                >
                  open peek
                </button>
                <MainLayout />
              </>
            </FilePreviewBridge>
          </div>
        </main>
      </div>
    </I18nProvider>
  )
}
