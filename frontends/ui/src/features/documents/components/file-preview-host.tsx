'use client'

/**
 * Persistent file preview in the project shell.
 *
 * Files: a modal. Chat: a second pane in a Resizable split — the file you
 * are asking about, not an overlay covering the conversation. Expand and
 * the Files modal still use the same pane as a dialog.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { usePanelRef } from 'react-resizable-panels'
import { Download, Maximize2, X } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { documentDisplayName } from '@/lib/documents/display-name'
import { cn } from '@/lib/utils'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentActions, type DocumentScope } from './document-actions'
import { FilePreviewPane } from './file-preview-pane'
import type { FileItem } from './project-file-workspace'
import {
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
  const prefersReducedMotion = useReducedMotion()
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
  const researchOpen = useLayoutStore((state) => state.rightPanel === 'research')
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onChat = Boolean(pathname?.includes('/chat'))
  const inSplit = presentation === 'split'
  const overlay = mode === 'modal' || (mode === 'expanded' && onChat && !hidden)
  const peeking =
    inSplit || (mode === 'peek' && onChat && !hidden && !researchOpen && !isMobile)
  const chromeVisible = file !== null && (overlay || peeking)
  // Keep the pane mounted across Files → Chat so an IFC viewport is not remounted
  // (and its camera reset) when Ask flips mode to peek while still on /files.
  const parked = file !== null && !chromeVisible

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

  if (!file) return null

  const name = documentDisplayName(file)
  const panePresentation = mode === 'peek' ? 'peek' : mode === 'expanded' ? 'expanded' : 'modal'

  return (
    <>
      {chromeVisible && overlay && (
        <div
          className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
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
        className={cn(
          'flex flex-col overflow-hidden outline-none',
          parked &&
            'invisible pointer-events-none fixed top-0 left-[-120vw] z-[-1] h-[80vh]',
          peeking && 'group h-full min-h-0 min-w-0 border-l border-border bg-card',
          !parked && !peeking && 'group z-40',
          !parked &&
            !peeking &&
            'bg-popover text-popover-foreground fixed left-1/2 top-1/2 z-50 h-[85vh] w-[min(960px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border shadow-lg',
        )}
        style={{
          width: parked || (peeking && !inSplit) ? peekWidth : undefined,
          transition: prefersReducedMotion || parked ? 'none' : 'opacity 200ms ease, transform 200ms ease',
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

function useFileAskSplit(): boolean {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const researchOpen = useLayoutStore((state) => state.rightPanel === 'research')
  const file = useFilePreviewStore((state) => state.file)
  const mode = useFilePreviewStore((state) => state.mode)
  const hidden = useFilePreviewStore((state) => state.hidden)
  return (
    file !== null &&
    mode === 'peek' &&
    !hidden &&
    Boolean(pathname?.includes('/chat')) &&
    !isMobile &&
    !researchOpen
  )
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
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children}
      </ResizablePanel>
      {split ? (
        <ResizableHandle
          key="grid-file-ask-handle"
          withHandle
          // The library makes every separator a tab stop, so this one is a
          // control a keyboard reader lands on and its arrow keys resize the
          // pane. Unnamed, it is announced as a separator and nothing else.
          aria-label={t('preview.resizePeek')}
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
  const split = useFileAskSplit()
  // Always the same tree. Switching a wrapping <div> for the split remounts
  // the project page (chat draft, files selection, upload tray).
  return <FilePreviewSplit split={split}>{children}</FilePreviewSplit>
}

const peekIconButtonClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-7 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity duration-quick ease-out hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100'

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
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2.5">
      <p className="text-foreground min-w-0 flex-1 truncate text-xs font-medium tracking-[-0.01em]">
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
        <Download className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onExpand}
        aria-label={t('assignment.expandFile')}
        title={t('assignment.expandFile')}
        className={peekIconButtonClass}
      >
        <Maximize2 className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onHide}
        aria-label={t('preview.closePreview')}
        className={peekIconButtonClass}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
