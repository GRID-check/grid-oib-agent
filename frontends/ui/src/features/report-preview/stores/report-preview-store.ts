/**
 * The report's PDF preview: whether it is open, and how wide the reader made it.
 *
 * Deliberately NOT `documents/stores/file-preview-store`. That store owns the
 * one FILE a conversation is talking about — it carries a `FileItem`, a modal /
 * peek / expanded mode and a composer subject, and closing it drops the chip in
 * the composer. The report preview shares none of that: it is a rendering of
 * text the app already has, it has exactly two states, and its width is a
 * different reader decision that must not be overwritten every time somebody
 * drags the file peek. Two panes, two widths, two stores.
 *
 * Width lives here rather than in the component so a tab switch (report →
 * tasks → report) or a research-panel close does not silently reset a pane the
 * reader deliberately widened.
 */

import { create } from 'zustand'

/**
 * The narrowest useful PDF pane. An A4 page below ~280px renders body text at a
 * size nobody reads — at that point the pane is decoration, and the reader is
 * better served by closing it and using the markdown.
 */
export const REPORT_PREVIEW_WIDTH_MIN = 280
export const REPORT_PREVIEW_WIDTH_MAX = 720
export const REPORT_PREVIEW_WIDTH_DEFAULT = 420

/**
 * The markdown column's floor. The preview opens BESIDE the report, so the
 * report has to survive it: a body column under ~260px wraps prose to four or
 * five words a line, which is the point at which the split stops being "the
 * report and its PDF" and becomes two unreadable strips.
 */
export const REPORT_BODY_WIDTH_MIN = 260

interface ReportPreviewState {
  /** Whether the PDF pane is showing beside (mobile: instead of) the report. */
  open: boolean
  /** Pane width in pixels, as last dragged. */
  width: number
  openPreview: () => void
  closePreview: () => void
  togglePreview: () => void
  setWidth: (width: number) => void
}

export const useReportPreviewStore = create<ReportPreviewState>((set, get) => ({
  open: false,
  width: REPORT_PREVIEW_WIDTH_DEFAULT,

  openPreview: () => set({ open: true }),
  closePreview: () => set({ open: false }),
  togglePreview: () => set({ open: !get().open }),

  // Clamped on the way IN, not on the way out. `onResize` reports whatever the
  // layout settled on — including sizes below `minSize` while a group is being
  // squeezed — and an unclamped value stored from one cramped frame is the
  // width the pane would reopen at forever.
  setWidth: (width) =>
    set({
      width: Math.min(
        REPORT_PREVIEW_WIDTH_MAX,
        Math.max(REPORT_PREVIEW_WIDTH_MIN, Math.round(width)),
      ),
    }),
}))
