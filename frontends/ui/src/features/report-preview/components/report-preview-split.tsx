'use client'

/**
 * The report row: the rendered markdown, and — when the reader asks for it —
 * the PDF beside it, on a handle they can drag.
 *
 * THE ROOM IS MADE HERE, AND ONLY HERE. This group is the report tab's content
 * row, so the markdown column yielding width to the PDF pane is a fact of this
 * subtree and of nothing outside it. Nobody above (`ReportTab`,
 * `ResearchPanel`, `MainLayout`) subtracts the pane's width as well — that
 * double-subtraction is the bug `MainLayout` carries a long comment about,
 * where the chat column shrank for a file peek that had already been given its
 * own panel and left a 344px dead band with the drag handle stranded past it.
 * If this pane ever needs to live somewhere else, MOVE the group; do not add a
 * second width calculation.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { ReportPdfPreview } from './report-pdf-preview'
import {
  REPORT_BODY_WIDTH_MIN,
  REPORT_PREVIEW_WIDTH_MAX,
  REPORT_PREVIEW_WIDTH_MIN,
  useReportPreviewStore,
} from '../stores/report-preview-store'

export function ReportPreviewSplit({ children }: { children: ReactNode }): JSX.Element {
  const open = useReportPreviewStore((state) => state.open)
  const width = useReportPreviewStore((state) => state.width)
  const setWidth = useReportPreviewStore((state) => state.setWidth)
  const closePreview = useReportPreviewStore((state) => state.closePreview)
  const isMobile = useIsMobile()
  const previewPanelRef = usePanelRef()
  // Read inside the effect below without making the effect depend on it —
  // otherwise every pixel of a drag would re-run the open sequence and fight
  // the pointer for the width it is currently setting.
  const widthRef = useRef(width)
  widthRef.current = width

  // OPEN THE PANEL, DON'T JUST RESIZE IT.
  //
  // The panel is `collapsible`, and it is COLLAPSED on the journey that
  // matters: the report tab mounts with the preview closed (that is the
  // default, and it is what a reader who never touches the pane always sees),
  // so the first `expand` request always arrives at a panel sitting at
  // `collapsedSize` — and `resize()` alone does not bring a collapsed panel
  // back. It reports success, the pane mounts, and it mounts inside zero
  // pixels parked off the edge of the row. `expand()` first is what puts the
  // panel back in the layout; `resize()` then puts it at the reader's width
  // instead of whatever it collapsed from (which, on a cold mount, is nothing).
  useLayoutEffect(() => {
    const panel = previewPanelRef.current
    if (!panel) return
    if (!open) {
      panel.collapse()
      return
    }
    panel.expand()
    // Mobile is a TAKEOVER, not a split. The research panel is already the
    // whole viewport there, so a 280px pane beside a 280px report is two
    // columns too narrow to read instead of one that works — the reader
    // toggles between them rather than comparing them.
    panel.resize(isMobile ? '100' : widthRef.current)
  }, [open, isMobile, previewPanelRef])

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
      id="grid-report-preview"
    >
      <ResizablePanel
        id="grid-report-preview-body"
        defaultSize="100"
        // Percent zero on mobile so the takeover above can actually take the
        // row; a pixel floor there would clamp the PDF pane back to a sliver.
        minSize={isMobile ? '0' : REPORT_BODY_WIDTH_MIN}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {children}
      </ResizablePanel>
      {/* No handle when there is nothing to drag between: closed, or a mobile
          takeover where the two panes do not share the row. */}
      {open && !isMobile ? <ResizableHandle withHandle /> : null}
      <ResizablePanel
        id="grid-report-preview-pdf"
        panelRef={previewPanelRef}
        // CONSTANT, not `open ? … : 0`. `defaultSize` is read once at mount and
        // never revisited, and bounds derived from the flag would all be zero
        // at the moment the effect above asks the panel to open — the panel's
        // own constraints would then answer "you may not be wider than
        // nothing". The flag drives one thing: collapsed or not.
        defaultSize={width}
        minSize={isMobile ? '0' : REPORT_PREVIEW_WIDTH_MIN}
        maxSize={isMobile ? '100' : REPORT_PREVIEW_WIDTH_MAX}
        collapsible
        collapsedSize={0}
        className="min-h-0 min-w-0"
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          // Only a real drag of a real split is a width decision. The collapse
          // to 0 and the mobile takeover to 100% are the app's own moves, and
          // storing either would reopen the pane at a width nobody chose.
          if (open && !isMobile && size.inPixels > 0) setWidth(size.inPixels)
        }}
      >
        {/* Unmounted while collapsed, unlike the file peek — that pane stays
            mounted to keep an IFC camera alive, and this one has the opposite
            problem: a PDF held in a zero-width iframe is megabytes of blob
            nobody can see. */}
        {open ? <ReportPdfPreview onClose={closePreview} /> : null}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
