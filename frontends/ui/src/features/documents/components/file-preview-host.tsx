'use client'

/**
 * Persistent file preview in the project shell.
 *
 * Files: a modal. Chat: a second pane in a Resizable split — the file you
 * are asking about, not an overlay covering the conversation. Expand and
 * the Files modal still use the same pane as a dialog.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { usePanelRef } from 'react-resizable-panels'
import { AlertCircle, Download, Maximize2, PanelRight, X } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { documentDisplayName } from '@/lib/documents/display-name'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Spinner } from '@/components/ui/spinner'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useLayoutStore } from '@/features/layout/store'
import { useSettlingRefresh } from '../hooks/use-settling-refresh'
import { useDocumentActions, type DocumentScope } from './document-actions'
import { isCitableStatus, isFailedStatus } from './document-status'
import { FilePreviewPane } from './file-preview-pane'
import type { FileItem } from './project-file-workspace'
import {
  FILE_PEEK_WIDTH_DEFAULT,
  FILE_PEEK_WIDTH_MAX,
  FILE_PEEK_WIDTH_MIN,
  useFilePreviewStore,
} from '../stores/file-preview-store'

export function FilePreviewHost({
  presentation,
}: {
  presentation?: 'split'
} = {}): JSX.Element | null {
  const t = useTranslations('files')
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const file = useFilePreviewStore((state) => state.file)
  const mode = useFilePreviewStore((state) => state.mode)
  const hidden = useFilePreviewStore((state) => state.hidden)
  const context = useFilePreviewStore((state) => state.context)
  const close = useFilePreviewStore((state) => state.close)
  const hide = useFilePreviewStore((state) => state.hide)
  const peek = useFilePreviewStore((state) => state.peek)
  const expand = useFilePreviewStore((state) => state.expand)
  const peekWidth = useFilePreviewStore((state) => state.peekWidth)
  const patchFile = useFilePreviewStore((state) => state.patchFile)
  const fileId = file?.id ?? null
  const fileStatus = file?.status ?? null
  // A list of one, for the shared settling poll below. Memoised so the poll's
  // effect is not re-armed on every render of the pane.
  const settlingItems = useMemo(
    () => (fileId ? [{ status: fileStatus }] : []),
    [fileId, fileStatus],
  )
  const researchOpen = useLayoutStore((state) => state.rightPanel === 'research')
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  /**
   * True for one animation, when the pane BECOMES the peek.
   *
   * It cannot be a plain entrance class. This element deliberately survives
   * parked → peek (it is what keeps an IFC camera from resetting), and a CSS
   * animation only runs when it is newly APPLIED — so a class sitting on a
   * mounted element fires once in the life of the project shell and never
   * again. Applying it on the transition is what makes every arrival animate,
   * and `onAnimationEnd` takes it off so the next one can. Under reduced motion
   * the global rule collapses the duration to 0.01ms, so the end event still
   * lands and this still clears itself.
   */
  const [arriving, setArriving] = useState(false)
  const onChat = Boolean(pathname?.includes('/chat'))
  const inSplit = presentation === 'split'
  const overlay = mode === 'modal' || (mode === 'expanded' && onChat && !hidden)
  const peeking =
    inSplit || (mode === 'peek' && onChat && !hidden && !researchOpen && !isMobile)
  const chromeVisible = file !== null && (overlay || peeking)
  // Keep the pane mounted across Files → Chat so an IFC viewport is not remounted
  // (and its camera reset) when Ask flips mode to peek while still on /files.
  const parked = file !== null && !chromeVisible

  // Arrivals AND swaps. A citation opening a second document into a pane that
  // is already there changes the toolbar's name and reloads the well with no
  // other signal — the same entrance says "this is a different document now",
  // which is the question the reader would otherwise have to answer by reading
  // the filename.
  const lastArrival = useRef<string | null>(null)
  useEffect(() => {
    const arrival = peeking && fileId ? fileId : null
    if (arrival && arrival !== lastArrival.current) setArriving(true)
    lastArrival.current = arrival
  }, [peeking, fileId])

  useEffect(() => {
    if (!chromeVisible || !overlay) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    panelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (mode === 'expanded') peek()
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [chromeVisible, overlay, mode, close, peek])

  useEffect(() => {
    if (chromeVisible) return
    const opener = openerRef.current
    if (opener?.isConnected) opener.focus()
  }, [chromeVisible])

  // Parked pane stays mounted (IFC camera) but must not take focus or sit in
  // the a11y tree. React 18 has no typing for `inert`, so set it on the node.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    if (parked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [parked])

  /**
   * A document that is still being read settles ON SCREEN.
   *
   * The store holds a snapshot taken when the file was opened, and nothing
   * refreshed it, so a peek opened seconds after an upload wore "Wird
   * gelesen…" until the reader closed and reopened it — and now that the peek
   * SHOWS that status, a stale badge would be a new way to be wrong rather
   * than the missing answer it is meant to be. Same hook the document lists
   * use, over a list of one: it polls only while the status can still change
   * and stops the moment it is terminal.
   */
  const refreshStatus = useCallback(async () => {
    const id = fileId
    if (!id) return
    try {
      const res = await fetch(`/api/documents/${id}/status`)
      if (!res.ok) return
      const data: unknown = await res.json()
      const status = (data as { status?: unknown } | null)?.status
      // Guard the id: a slow answer for the PREVIOUS document must not land on
      // the one the reader has since opened.
      if (typeof status === 'string' && useFilePreviewStore.getState().file?.id === id) {
        patchFile({ status })
      }
    } catch {
      // Offline or a hiccup — the poll's next tick asks again.
    }
  }, [fileId, patchFile])
  useSettlingRefresh(settlingItems, refreshStatus)

  if (!file) return null

  const name = documentDisplayName(file)
  const panePresentation = mode === 'peek' ? 'peek' : mode === 'expanded' ? 'expanded' : 'modal'

  return (
    <>
      {chromeVisible && overlay && (
        <div
          // Fades. The scrim used to appear in a single frame, which reads as
          // the page being replaced rather than as something opening ON it —
          // and the pane behind it did the same, so enlarging a document was
          // two hard cuts. `duration-quick`/`ease-out` is the vocabulary's
          // entry for an opacity change.
          className="bg-overlay animate-in fade-in-0 fixed inset-0 z-50 backdrop-blur-sm duration-quick ease-out motion-reduce:animate-none"
          onClick={mode === 'expanded' ? peek : close}
          aria-hidden
        />
      )}
      <div
        ref={panelRef}
        role={parked ? undefined : peeking ? 'complementary' : 'dialog'}
        aria-modal={chromeVisible && overlay ? true : undefined}
        aria-label={parked ? undefined : t('preview.dialogLabel', { name })}
        aria-hidden={parked || undefined}
        tabIndex={parked ? undefined : -1}
        data-testid="file-preview-host"
        data-mode={parked ? 'parked' : peeking ? 'peek' : mode}
        onAnimationEnd={() => setArriving(false)}
        onKeyDown={
          peeking
            ? (event) => {
                if (event.key !== 'Escape') return
                // Scoped to focus INSIDE the pane, by being a React handler on
                // it: the peek is not modal, so a global listener would close
                // the reader's document out from under a composer they were
                // typing Escape into for another reason. `DockedPanel` answers
                // Escape the same way; this one used to be the only panel in
                // the app that did not.
                event.stopPropagation()
                dismissPeek(hide)
              }
            : undefined
        }
        className={cn(
          'flex flex-col overflow-hidden outline-none',
          parked &&
            'invisible pointer-events-none fixed top-0 left-[-120vw] z-[-1] h-[80vh]',
          peeking && 'group h-full min-h-0 min-w-0 bg-card',
          // The seam is ONE hairline. This pane carried a `border-l` and the
          // resize handle beside it is itself a 1px line in the same colour —
          // so the join between the conversation and the document was drawn
          // twice, 2px of chrome where every other divider in the app is 1.
          // The handle wins: it is the one that can respond to a pointer. Off
          // the split (no handle to lean on) the pane draws its own edge.
          peeking && !inSplit && 'border-l border-border',
          // The pane's WIDTH is set in one pass by the panel around it — the
          // design language's binding constraint, and the reason nothing here
          // tweens a layout property. What arrives is the CONTENT: a fade and a
          // 16px settle from the edge it came in on, so the reader sees where
          // the document came from instead of finding it already there.
          peeking &&
            arriving &&
            'animate-in fade-in-0 slide-in-from-right-4 duration-deliberate ease-entrance motion-reduce:animate-none',
          !parked && !peeking && 'group z-40',
          !parked &&
            !peeking &&
            'bg-popover text-popover-foreground fixed left-1/2 top-1/2 z-50 h-[85vh] w-[min(960px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border shadow-lg',
          // The enlarged view arrives on the page it covers: fade plus a small
          // scale, `duration-base`/`ease-entrance` — the vocabulary's content
          // entrance. `zoom-in-95` is 5% of a 960px dialog, a settle rather
          // than a pounce, and `!parked` keeps the off-screen copy from
          // animating itself every time it is parked.
          !parked && !peeking && 'animate-in fade-in-0 zoom-in-95 duration-base ease-entrance motion-reduce:animate-none',
        )}
        style={{
          width: parked || (peeking && !inSplit) ? peekWidth : undefined,
        }}
      >
        {peeking && (
          <PeekToolbar
            file={file}
            scope={context.scope ?? 'files'}
            name={name}
            onExpand={expand}
            onHide={hide}
          />
        )}
        <FilePreviewPane
          file={file}
          projectId={context.projectId}
          projectName={context.projectName}
          canManage={context.canManage}
          scope={context.scope}
          canCollaborate={context.canCollaborate}
          showMetadataPanel={panePresentation === 'peek' ? false : context.showMetadataPanel}
          presentation={panePresentation}
          onClose={overlay ? (mode === 'expanded' ? peek : close) : hide}
          onRenamed={(fileId, displayName) => {
            if (fileId === file.id) patchFile({ displayName })
            context.onRenamed?.(fileId, displayName)
          }}
          onDeleted={(fileId) => {
            if (fileId === file.id) close()
            context.onDeleted?.(fileId)
          }}
          onReingested={(fileId, status) => {
            if (fileId === file.id) patchFile({ status })
            context.onReingested?.(fileId, status)
          }}
          onTagsUpdated={(fileId, tags) => {
            if (fileId === file.id) patchFile({ tags })
            context.onTagsUpdated?.(fileId, tags)
          }}
          onAssigneesChanged={(assignees) => patchFile({ assignees })}
        />
      </div>
    </>
  )
}

/**
 * Where the file peek stands relative to the conversation.
 *
 * `beside`     — on screen, in the split.
 * `dismissed`  — it WOULD be on screen; the reader put it away. Everything that
 *                offers to bring it back keys off this, and something always
 *                must: a dismissal that cannot be undone from where it happened
 *                is a door that only opens one way.
 * `away`       — no file, or the reader is somewhere the peek does not belong
 *                (Files, a phone, the research panel across the same half of
 *                the row, the enlarged view already covering the page).
 */
export type FilePeekPlacement = 'beside' | 'dismissed' | 'away'

export function useFilePeekPlacement(): FilePeekPlacement {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const researchOpen = useLayoutStore((state) => state.rightPanel === 'research')
  const file = useFilePreviewStore((state) => state.file)
  const mode = useFilePreviewStore((state) => state.mode)
  const hidden = useFilePreviewStore((state) => state.hidden)

  const roomForIt =
    file !== null && mode === 'peek' && Boolean(pathname?.includes('/chat')) && !isMobile && !researchOpen
  if (!roomForIt) return 'away'
  return hidden ? 'dismissed' : 'beside'
}

/**
 * Whether the peek is ON SCREEN beside the conversation right now.
 *
 * Six conditions, and the point of exporting it is that they are six: a file
 * can be open in the store, unhidden, in `peek` mode — and still invisible,
 * because the reader is on Files, or on a phone, or has the research panel
 * across the same half of the row. Everything that offers to bring the file
 * BACK has to ask this question, and the copy of it that the composer bar was
 * asking (mode and `hidden`, nothing else) answered "it is visible" for three
 * states in which nothing was on screen — so the one control that could have
 * restored the file was the control being hidden.
 */
export function useFilePeekBesideChat(): boolean {
  return useFilePeekPlacement() === 'beside'
}

/**
 * Keep FilePreviewHost as the right panel's child whenever a file is open, so
 * parked → peek (Files → Chat) is a size change rather than a remount.
 */
function FilePreviewSplit({
  split,
  children,
}: {
  split: boolean
  children: ReactNode
}): JSX.Element {
  const t = useTranslations('files')
  const peekWidth = useFilePreviewStore((state) => state.peekWidth)
  const setPeekWidth = useFilePreviewStore((state) => state.setPeekWidth)
  const restorePeekWidth = useFilePreviewStore((state) => state.restorePeekWidth)
  const hide = useFilePreviewStore((state) => state.hide)
  const peek = useFilePreviewStore((state) => state.peek)
  const dismissed = useFilePeekPlacement() === 'dismissed'
  const filePanelRef = usePanelRef()
  const peekWidthRef = useRef(peekWidth)
  peekWidthRef.current = peekWidth

  // A MOUNT-TIME value, captured once — the seam could not be dragged without it.
  //
  // `defaultSize` used to be the LIVE store width, and the panel's `onResize`
  // wrote every intermediate width straight back into that store. So each
  // pointer move re-rendered the group with a new `defaultSize`, the library
  // recomputed the layout from it (a default-size change is one of the sources
  // its own `LayoutChangedMeta` lists), and the recompute landed on top of the
  // drag in progress. The seam moved about twenty pixels and then stopped dead,
  // whichever direction it was pulled — resizable in principle, immovable in
  // the hand. The width is committed once per gesture now, in
  // `onLayoutChanged`, and nothing the reader does feeds back into this prop.
  const mountWidthRef = useRef(peekWidth)

  // The remembered width, adopted before the panel is first sized. Assigning
  // `peekWidthRef` here as well is what lets the `split` effect below — same
  // commit, declared after this one — size the panel to it rather than to the
  // pre-restore default it read during render.
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const stored = restorePeekWidth()
    if (stored === null) return
    peekWidthRef.current = stored
    filePanelRef.current?.resize(stored)
  }, [restorePeekWidth, filePanelRef])

  // OPEN THE PANEL, DON'T JUST RESIZE IT.
  //
  // The panel is `collapsible`, and on the journey that matters it is COLLAPSED
  // when `split` flips: Ask Piloti starts in Files, and this bridge lives in the
  // PROJECT layout, so it mounts once for the whole project — with `split`
  // false — and is still mounted when the reader lands on chat. `resize()` alone
  // left it at 0 there: the pane rendered, in `peek` mode, inside a zero-width
  // panel parked off the right edge. `expand()` first is what takes a collapsed
  // panel back into the layout; `resize()` then puts it at the reader's width
  // rather than whatever it was last (which, on a cold mount, is zero).
  useLayoutEffect(() => {
    const panel = filePanelRef.current
    if (!panel) return
    if (!split) {
      panel.collapse()
      return
    }
    panel.expand()
    panel.resize(peekWidthRef.current)
  }, [split, filePanelRef])

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 flex-1"
      id="grid-file-ask"
      // ONCE PER GESTURE, not once per frame: this fires after the pointer is
      // released (and on each keyboard resize), which is the library's own
      // advice for anything that writes the layout to storage. The panel's
      // per-move `onResize` used to do this job, and paid for it twice — a
      // synchronous localStorage write per frame, and the feedback loop
      // described on `mountWidthRef` above.
      onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction) return
        const size = filePanelRef.current?.getSize()
        if (!size) return
        if (size.inPixels > 0) {
          setPeekWidth(size.inPixels)
          return
        }
        // Dragged shut. The panel is `collapsible` — it has to be, since that
        // is how the split parks itself when there is no file — so pulling the
        // seam past the minimum is a gesture the reader can always reach, and
        // leaving it there would strand a one-pixel sliver of a document they
        // are still asking about. It means the same thing as the ✕ on the peek:
        // put the viewer away, keep the question. `hide()` also keeps the
        // composer's "Asking about …" bar, whose "Show file" brings it back.
        hide()
      }}
    >
      <ResizablePanel
        key="grid-file-ask-chat"
        id="grid-file-ask-chat"
        defaultSize="100"
        minSize="40"
        className="relative min-h-0 min-w-0 overflow-hidden"
      >
        {children}
        {/* THE UNDO, AT THE EDGE THE DOCUMENT LEFT BY.
            Dragging the seam shut, pressing Escape, clicking the ✕ — three
            gestures, one result, and the only way back was a control in the
            composer that belongs to the QUESTION rather than to the viewer. A
            reader who has just pulled a pane off the screen looks for it where
            they pulled it, so that is where it waits: a tab on the edge it went
            out through, which opens it again at the width they had chosen.
            It costs 20px of a row it only occupies while something is
            recoverable, and it means no gesture on this surface is one-way. */}
        {dismissed && (
          <button
            type="button"
            data-testid="file-peek-restore"
            onClick={peek}
            aria-label={t('assignment.showFile')}
            title={t('assignment.showFile')}
            className={cn(
              'group/restore bg-card text-muted-foreground hover:text-foreground hover:bg-accent border-base absolute top-1/2 right-0 z-20 flex h-16 w-6 -translate-y-1/2 items-center justify-center rounded-l-lg border border-r-0 shadow-sm',
              'transition-colors duration-quick ease-out motion-reduce:transition-none',
              'animate-in fade-in-0 slide-in-from-right-2 duration-base ease-entrance motion-reduce:animate-none',
              FOCUS_RING,
            )}
          >
            {/* `PanelRight`, not a bare chevron: the rail on the other side of
                the app opens with `PanelLeft`, so a reader who has met one
                already knows what this is. It leans out on approach — a tab you
                pull, not a button you press; one pixel, and it is the whole
                difference between "something is here" and "take hold of this". */}
            <PanelRight
              className="size-3.5 transition-transform duration-quick ease-out group-hover/restore:-translate-x-px motion-reduce:transition-none"
              aria-hidden
            />
          </button>
        )}
      </ResizablePanel>
      {split ? (
        <ResizableHandle
          key="grid-file-ask-handle"
          withHandle
          // The library makes every separator a tab stop, so this one is a
          // control a keyboard reader lands on and its arrow keys resize the
          // pane. Unnamed, it is announced as a separator and nothing else.
          aria-label={t('preview.resizePeek')}
          // The library's own double-click COLLAPSES a collapsible panel, and
          // collapsed is one pixel: two quick clicks near the seam left a
          // sliver of a document the reader was still asking about, with no
          // word about where it went. Double-click on a splitter means "put it
          // back", so that is what it does — the default width, in one pass.
          disableDoubleClick
          onDoubleClick={() => {
            filePanelRef.current?.expand()
            filePanelRef.current?.resize(FILE_PEEK_WIDTH_DEFAULT)
            setPeekWidth(FILE_PEEK_WIDTH_DEFAULT)
          }}
        />
      ) : null}
      <ResizablePanel
        key="grid-file-ask-file"
        id="grid-file-ask-file"
        panelRef={filePanelRef}
        // CONSTANT, not `split ? … : 0`. These used to collapse to zero with the
        // flag, which meant the panel's own bounds said "you may not be wider
        // than nothing" at the exact moment the effect above asked it to open —
        // and a mount-time `defaultSize` never gets a second chance to say
        // otherwise. The flag now drives one thing only: collapsed or not.
        // `defaultSize` is likewise a mount value and not the live width — see
        // `mountWidthRef`.
        defaultSize={mountWidthRef.current}
        minSize={FILE_PEEK_WIDTH_MIN}
        maxSize={FILE_PEEK_WIDTH_MAX}
        collapsible
        collapsedSize={0}
        className="min-h-0 min-w-0"
        groupResizeBehavior="preserve-pixel-size"
      >
        <FilePreviewHost presentation={split ? 'split' : undefined} />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

export function FilePreviewBridge({ children }: { children: ReactNode }): JSX.Element {
  const split = useFilePeekBesideChat()
  // Always the same tree. Switching a wrapping <div> for the split remounts
  // the project page (chat draft, files selection, upload tray).
  return <FilePreviewSplit split={split}>{children}</FilePreviewSplit>
}

/**
 * Put the viewer away, and put focus somewhere that means something.
 *
 * Whatever dismissed the peek — the ✕ or Escape — the element that had focus is
 * inside the pane that is about to stop existing, and left alone the browser
 * drops focus on `<body>`: a keyboard reader restarts from the top of the page,
 * several tab stops from the conversation they were in the middle of. It goes
 * instead to the control that UNDOES the move, "Show file" in the composer,
 * which appears in the same commit. Queried rather than threaded through: the
 * composer belongs to another feature, and a ref across that seam would be a
 * prop chain three components deep for one focus call. If the bar is not there
 * (a peek with no composer subject), nothing moves — better than a guess.
 */
function dismissPeek(hide: () => void): void {
  hide()
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-testid="composer-show-file"]')?.focus()
  })
}

/**
 * The peek's own actions, built to the chat's proportions.
 *
 * `size-9` and `rounded-md` are the pill buttons' across the seam, so the two
 * halves of the row are the same control size rather than 28px against 36px.
 * The ring is the app's shared recipe (`FOCUS_RING`) instead of a third
 * hand-rolled variant — `grid-design-language.md` allows exactly two, and a
 * control that invents its own teaches the reader that the ring means nothing.
 */
const peekIconButtonClass = cn(
  'text-muted-foreground hover:text-foreground hover:bg-accent flex size-9 shrink-0 items-center justify-center rounded-md',
  'opacity-70 transition-[opacity,color,background-color] duration-quick ease-out motion-reduce:transition-none',
  'focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100',
  FOCUS_RING,
)

function PeekToolbar({
  file,
  scope,
  name,
  onExpand,
  onHide,
}: {
  file: FileItem
  scope: DocumentScope
  name: string
  onExpand: () => void
  onHide: () => void
}): JSX.Element {
  const t = useTranslations('files')
  const actions = useDocumentActions({ document: file, scope })
  // Shown only when it is NOT the answer the reader assumes. A peek exists
  // because this file is what the next question is about, and a document that
  // is still indexing (or failed) is one the agent cannot cite — the modal has
  // said so under the name since the day it was built, and the peek, the one
  // surface whose whole reason is "you are asking about this", said nothing.
  // Silent for a citable file: quiet chrome is the point of the peek.
  const unreadable = !isCitableStatus(file.status)
  return (
    <>
    {/* 48px row, held 10px off the top — the same band the chat's own pills
        occupy (`ChatToolbar`: `pt-2.5` + `min-h-12`), so the file's name and the
        session's title sit on one line across the seam instead of missing each
        other by fourteen pixels. `DockedPanel` matches the same band for the
        same reason. */}
    <div className="mt-2.5 flex h-12 shrink-0 items-center gap-0.5 px-3">
      <p
        // `text-sm`, like the session title in the pills across the seam. At
        // `text-xs` the two names sat on one line in two different sizes, which
        // reads as two unrelated surfaces that happen to be adjacent.
        className="text-foreground min-w-0 flex-1 truncate px-1 text-sm font-medium tracking-[-0.01em]"
        // The pane is 280px at its narrowest and a plan's filename is not.
        title={name}
      >
        {name}
      </p>
      <button
        type="button"
        onClick={() => void actions.download()}
        disabled={actions.isDownloading}
        aria-label={t('preview.download')}
        title={t('preview.download')}
        className={`${peekIconButtonClass} disabled:opacity-40`}
      >
        <Download className="size-4" />
      </button>
      <button
        type="button"
        onClick={onExpand}
        aria-label={t('assignment.expandFile')}
        title={t('assignment.expandFile')}
        className={peekIconButtonClass}
      >
        <Maximize2 className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => dismissPeek(onHide)}
        aria-label={t('preview.closePreview')}
        className={peekIconButtonClass}
      >
        <X className="size-4" />
      </button>
    </div>
    {/* A STRIP, not a chip beside the name.
        The status has to be here at all: a peek exists because this file is
        what the next question is about, and a document still being read (or
        one that failed) is a document the agent cannot cite — the modal has
        said so under the name since it was built, and the peek, the surface
        whose whole reason is that sentence, said nothing.
        It is a strip because the row above is 280px at its narrowest and a
        badge in it left "Brandschutzp…" beside "Wird verarbeitet": the
        identity truncated to make room for a word whose CONSEQUENCE — the
        answer will not use this file — fitted nowhere but a tooltip. On its
        own line both fit, and the sentence is the part that matters.
        Nothing at all for a citable file: quiet chrome is the point of the
        peek, and a badge that says "fine" on every document is a badge nobody
        reads when it says something else. */}
    {unreadable && (
      <div
        role="status"
        className={cn(
          // `items-start`, not centre: the sentence wraps to two lines in the
          // narrow pane, and a badge floating against the middle of a paragraph
          // reads as unrelated to it. Aligned to the first line it reads as the
          // sentence's subject, which is what it is.
          'flex shrink-0 items-start gap-2 border-b px-3 pb-2.5 text-xs',
          // TWO REGISTERS, because they are two different pieces of news.
          // "Still being read" is the ordinary state of a document somebody
          // just uploaded: it resolves itself, so it sits on the quiet ground
          // and lets the badge carry the only colour. A failure will not
          // resolve itself, so it takes the destructive tint and the reader's
          // attention — the same register `project-danger-zone` uses.
          isFailedStatus(file.status)
            ? 'border-destructive/25 bg-destructive/[0.05]'
            : 'border-base bg-surface-sunken',
        )}
      >
        {/* ONE carrier of state per strip. A solid destructive badge on a
            destructive ground said "failed" twice and shouted the second time,
            next to the control the reader actually needs; and a badge plus a
            sentence that already names the state is the same word rendered at
            two weights. So the mark is a mark: a spinner while the document is
            being read — which is the honest answer to "what do I do about
            this", since the answer is "nothing, it is happening" — and an alert
            glyph when it will not resolve on its own. */}
        {isFailedStatus(file.status) ? (
          <AlertCircle className="text-destructive mt-0.5 size-3.5 shrink-0" aria-hidden />
        ) : (
          <Spinner size="xs" aria-hidden className="text-muted-foreground mt-0.5 shrink-0" />
        )}
        <p className="text-muted-foreground min-w-0 flex-1 text-pretty leading-snug">
          {isFailedStatus(file.status)
            ? t('preview.peekFailedHint')
            : t('preview.peekIndexingHint')}
        </p>
        {/* NO DEAD ENDS. "Piloti cannot cite this file" was a statement with
            nothing after it — the worst kind of message, because it tells the
            reader the question they are about to ask is already compromised
            and then leaves them holding it. The enlarged view is where this
            document's own account of the failure lives: the ingestion error in
            full, and the retry for whoever may run it. So the strip opens it.
            The indexing case needs no control — it resolves itself, and the
            poll above is what makes that visible. */}
        {isFailedStatus(file.status) && (
          <button
            type="button"
            onClick={onExpand}
            className={cn(
              'text-foreground hover:bg-accent shrink-0 rounded-md px-1.5 py-0.5 font-medium underline-offset-2 hover:underline',
              FOCUS_RING,
            )}
          >
            {t('preview.peekFailedAction')}
          </button>
        )}
      </div>
    )}
    </>
  )
}
