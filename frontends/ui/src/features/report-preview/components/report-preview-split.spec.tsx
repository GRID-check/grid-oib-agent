/**
 * The report row, at the level the panel actually lives on.
 *
 * jsdom/happy-dom has no layout, so the real library could not tell us a width
 * here even if we asked it. What it CAN be held to is the instructions we give
 * it: the size constraints the PDF panel is declared with, and the imperative
 * calls made when the reader opens and closes the pane. Both are ours; neither
 * is the library's behaviour under test.
 *
 * The mechanism, for whoever breaks this next. The report tab mounts with the
 * preview CLOSED — that is the default and the only state most readers see —
 * so the panel is genuinely `collapsed` when the first open arrives, and
 * `resize()` alone does not bring a collapsed panel back. Size constraints
 * derived from the open flag are all zero at that same moment, and `defaultSize`
 * is read once at mount and never revisited.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import {
  REPORT_BODY_WIDTH_MIN,
  REPORT_PREVIEW_WIDTH_DEFAULT,
  REPORT_PREVIEW_WIDTH_MAX,
  REPORT_PREVIEW_WIDTH_MIN,
  useReportPreviewStore,
} from '../stores/report-preview-store'

/** Imperative calls the split makes on the PDF panel, in order. */
const panel = vi.hoisted(() => ({ calls: [] as string[] }))
/** Props the PDF panel was last rendered with. */
const declared = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))
/** Props the report-body panel was last rendered with. */
const bodyDeclared = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))
const viewport = vi.hoisted(() => ({ isMobile: false }))

vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.isMobile }))
vi.mock('./report-pdf-preview', async () => {
  const React = await import('react')
  return {
    ReportPdfPreview: () => React.createElement('div', { 'data-testid': 'report-pdf-preview' }),
  }
})

// A stand-in for the panel library that records rather than lays out.
vi.mock('react-resizable-panels', async () => {
  const React = await import('react')
  const handle = {
    collapse: () => panel.calls.push('collapse'),
    expand: () => panel.calls.push('expand'),
    resize: (size: number | string) => panel.calls.push(`resize:${size}`),
    isCollapsed: false,
    isExpanded: true,
  }
  return {
    usePanelRef: () => React.useRef(handle),
    Group: ({ children, ...rest }: Record<string, unknown> & { children?: unknown }) =>
      React.createElement(
        'div',
        { 'data-slot': 'resizable-panel-group', ...pickDom(rest) },
        children as never,
      ),
    Panel: ({ children, id, ...rest }: Record<string, unknown> & { children?: unknown; id?: string }) => {
      if (id === 'grid-report-preview-pdf') declared.current = rest
      if (id === 'grid-report-preview-body') bodyDeclared.current = rest
      return React.createElement(
        'div',
        { 'data-slot': 'resizable-panel', id, ...pickDom(rest) },
        children as never,
      )
    },
    Separator: (rest: Record<string, unknown>) =>
      React.createElement('div', { role: 'separator', ...pickDom(rest) }),
  }
  /** Drop the library-only props so React does not warn about unknown DOM attributes. */
  function pickDom(props: Record<string, unknown>): Record<string, unknown> {
    const { className, style } = props
    return { ...(className ? { className } : {}), ...(style ? { style: style as object } : {}) }
  }
})

import { ReportPreviewSplit } from './report-preview-split'

const reset = (): void => {
  panel.calls = []
  declared.current = null
  bodyDeclared.current = null
  viewport.isMobile = false
  useReportPreviewStore.setState({ open: false, width: REPORT_PREVIEW_WIDTH_DEFAULT })
}

const renderSplit = () =>
  render(
    <ReportPreviewSplit>
      <div>report markdown</div>
    </ReportPreviewSplit>,
  )

describe('ReportPreviewSplit — the PDF panel actually opens', () => {
  beforeEach(reset)
  afterEach(reset)

  it('EXPANDS the panel, not just resizes it, when the reader opens the preview', () => {
    const { rerender } = renderSplit()
    expect(panel.calls).toEqual(['collapse'])

    panel.calls = []
    useReportPreviewStore.getState().openPreview()
    rerender(
      <ReportPreviewSplit>
        <div>report markdown</div>
      </ReportPreviewSplit>,
    )

    // `expand` MUST come first and MUST be there at all: a collapsed panel
    // ignores `resize`, which would leave the pane rendered inside zero pixels
    // parked off the edge of the row while every other assertion passed.
    expect(panel.calls).toEqual(['expand', `resize:${REPORT_PREVIEW_WIDTH_DEFAULT}`])
  })

  it('reopens at the width the reader last dragged it to', () => {
    useReportPreviewStore.setState({ width: 600 })
    useReportPreviewStore.getState().openPreview()
    renderSplit()

    expect(panel.calls).toEqual(['expand', 'resize:600'])
  })

  it('declares its size bounds independently of the open flag', () => {
    // Mounted CLOSED. The bounds must already be the real ones: `defaultSize`
    // is read once at mount, and bounds of zero would clamp the expand above
    // back to nothing.
    renderSplit()

    expect(declared.current).toMatchObject({
      defaultSize: REPORT_PREVIEW_WIDTH_DEFAULT,
      minSize: REPORT_PREVIEW_WIDTH_MIN,
      maxSize: REPORT_PREVIEW_WIDTH_MAX,
      collapsible: true,
      collapsedSize: 0,
      groupResizeBehavior: 'preserve-pixel-size',
    })
    // The report column has a floor of its own, or the pane could squeeze the
    // prose it is a preview of down to a strip.
    expect(bodyDeclared.current).toMatchObject({ minSize: REPORT_BODY_WIDTH_MIN })
  })

  it('collapses again when the preview is closed, so the report reclaims the row', () => {
    useReportPreviewStore.getState().openPreview()
    const { rerender } = renderSplit()
    expect(panel.calls).toEqual(['expand', `resize:${REPORT_PREVIEW_WIDTH_DEFAULT}`])

    panel.calls = []
    useReportPreviewStore.getState().closePreview()
    rerender(
      <ReportPreviewSplit>
        <div>report markdown</div>
      </ReportPreviewSplit>,
    )

    expect(panel.calls).toEqual(['collapse'])
  })

  it('mounts the pane only while open, so no PDF is held in a zero-width panel', () => {
    const { queryByTestId, rerender } = renderSplit()
    expect(queryByTestId('report-pdf-preview')).toBeNull()

    useReportPreviewStore.getState().openPreview()
    rerender(
      <ReportPreviewSplit>
        <div>report markdown</div>
      </ReportPreviewSplit>,
    )
    expect(queryByTestId('report-pdf-preview')).not.toBeNull()
  })

  it('shows a drag handle only when the two panes share the row', () => {
    const { queryByRole, rerender } = renderSplit()
    expect(queryByRole('separator')).toBeNull()

    useReportPreviewStore.getState().openPreview()
    rerender(
      <ReportPreviewSplit>
        <div>report markdown</div>
      </ReportPreviewSplit>,
    )
    expect(queryByRole('separator')).not.toBeNull()
  })
})

describe('ReportPreviewSplit — width persistence', () => {
  beforeEach(reset)
  afterEach(reset)

  it('stores the dragged width, clamped, so the pane reopens where it was left', () => {
    useReportPreviewStore.getState().openPreview()
    renderSplit()

    const onResize = declared.current?.onResize as (size: { inPixels: number }) => void
    onResize({ inPixels: 512.4 })
    expect(useReportPreviewStore.getState().width).toBe(512)

    // Dragged past the maximum in a frame where the group was being squeezed:
    // stored as the bound, not as the moment.
    onResize({ inPixels: REPORT_PREVIEW_WIDTH_MAX + 200 })
    expect(useReportPreviewStore.getState().width).toBe(REPORT_PREVIEW_WIDTH_MAX)
  })

  it('ignores the collapse to zero, which is the app moving the panel, not the reader', () => {
    useReportPreviewStore.getState().openPreview()
    renderSplit()

    const onResize = declared.current?.onResize as (size: { inPixels: number }) => void
    onResize({ inPixels: 480 })
    onResize({ inPixels: 0 })

    expect(useReportPreviewStore.getState().width).toBe(480)
  })
})

describe('ReportPreviewSplit — mobile', () => {
  beforeEach(reset)
  afterEach(reset)

  it('takes over the row instead of splitting it, and stores no width for it', () => {
    viewport.isMobile = true
    useReportPreviewStore.getState().openPreview()
    const { queryByRole } = renderSplit()

    // The research panel is already the whole viewport on mobile; two columns
    // out of it are two columns too narrow to read.
    expect(panel.calls).toEqual(['expand', 'resize:100'])
    expect(declared.current).toMatchObject({ minSize: '0', maxSize: '100' })
    expect(queryByRole('separator')).toBeNull()

    const onResize = declared.current?.onResize as (size: { inPixels: number }) => void
    onResize({ inPixels: 390 })
    expect(useReportPreviewStore.getState().width).toBe(REPORT_PREVIEW_WIDTH_DEFAULT)
  })
})
