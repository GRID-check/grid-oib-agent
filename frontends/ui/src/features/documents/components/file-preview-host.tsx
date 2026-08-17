'use client'

/**
 * Persistent file preview in the project shell.
 *
 * Files: a modal. Chat: the asked file as a floating frame — inset, the
 * same hairline + shadow-xs language as the toolbar pills. Expand uses
 * the same pane.
 */

import { useEffect, useRef, type PointerEvent } from 'react'
import { usePathname } from 'next/navigation'
import { Download, Maximize2, X } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { documentDisplayName } from '@/lib/documents/display-name'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentActions, type DocumentScope } from './document-actions'
import { FilePreviewPane } from './file-preview-pane'
import type { FileItem } from './project-file-workspace'
import { useFilePreviewStore } from '../stores/file-preview-store'

export function FilePreviewHost(): JSX.Element | null {
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
  const setPeekWidth = useFilePreviewStore((state) => state.setPeekWidth)
  const patchFile = useFilePreviewStore((state) => state.patchFile)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const researchOpen = useLayoutStore((state) => state.rightPanel === 'research')
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onChat = Boolean(pathname?.includes('/chat'))
  const overlay = mode === 'modal' || (mode === 'expanded' && onChat && !hidden)
  const peeking = mode === 'peek' && onChat && !hidden && !researchOpen && !isMobile
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

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startW: peekWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setPeekWidth(drag.startW + (drag.startX - event.clientX))
  }
  const onResizePointerUp = () => {
    dragRef.current = null
  }

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
          !parked && 'group z-40',
          !parked &&
            peeking &&
            'absolute top-14 right-3 bottom-3 rounded-2xl border border-base bg-card/95 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/90',
          !parked &&
            !peeking &&
            'bg-popover text-popover-foreground fixed left-1/2 top-1/2 z-50 h-[85vh] w-[min(960px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border shadow-lg',
        )}
        style={{
          width: peeking || parked ? peekWidth : undefined,
          transition: prefersReducedMotion || parked ? 'none' : 'opacity 200ms ease, transform 200ms ease',
        }}
      >
        {peeking && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('assignment.resizeFile')}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            className="hover:bg-foreground/10 absolute inset-y-3 left-0 z-10 w-1.5 cursor-ew-resize rounded-full"
          />
        )}
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

export function FilePreviewBridge({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <>
      {children}
      <FilePreviewHost />
    </>
  )
}

const peekIconButtonClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-7 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100'

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
      <p className="text-foreground min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.01em]">
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
