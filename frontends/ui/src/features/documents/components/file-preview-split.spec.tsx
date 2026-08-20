/**
 * The Files → chat transition, at the level the bug actually lived on.
 *
 * `file-preview-host.spec.tsx` already covers this journey and stayed green
 * through it, because it asserts `data-mode` and the pane's mount count — the
 * half that was never broken. The pane rendered, in `peek` mode, correctly not
 * remounted, inside a panel that was ZERO PIXELS WIDE and parked off the right
 * edge of the viewport. Nothing observed the panel.
 *
 * So this file stubs `react-resizable-panels` and observes exactly two things
 * the real library would act on: the size constraints the file panel is
 * declared with, and the imperative calls made when `split` flips. Both are
 * ours; neither is the library's behaviour under test.
 *
 * The mechanism, for whoever breaks this next. `FilePreviewBridge` is mounted
 * by the PROJECT layout, so it mounts once per project and survives the move
 * from Files to chat. On that mount `split` is false. If the panel's
 * `defaultSize` / `minSize` / `maxSize` are derived from `split`, they are all
 * zero at that moment — and `defaultSize` is a mount-time value that never gets
 * a second chance. The panel is also `collapsible`, so it is genuinely
 * COLLAPSED, and `resize()` alone does not bring a collapsed panel back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useFilePreviewStore } from '../stores/file-preview-store'
import type { FileItem } from './project-file-workspace'

const nav = vi.hoisted(() => ({ pathname: '/app/projects/p1/files' }))
/** Imperative calls the split makes on the file panel, in order. */
const panel = vi.hoisted(() => ({ calls: [] as string[], sizeInPixels: 320 }))
/** Size constraints the file panel was last rendered with. */
const declared = vi.hoisted(
  () => ({ current: null as null | Record<string, unknown> }),
)
/**
 * The group's `onLayoutChanged`, as last rendered. Standing in for the library
 * is the only way to fire it here: it is the library that decides a gesture has
 * ENDED, and jsdom has no layout for it to decide anything from.
 */
const group = vi.hoisted(
  () => ({
    onLayoutChanged: null as
      | null
      | ((layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void),
  }),
)

vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }))
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: (selector: (state: { rightPanel: null }) => unknown) =>
    selector({ rightPanel: null }),
}))
vi.mock('./file-preview-pane', async () => {
  const React = await import('react')
  return {
    FilePreviewPane: () => React.createElement('div', { 'data-testid': 'file-preview-pane' }),
  }
})

// A stand-in for the panel library that records rather than lays out. jsdom has
// no layout, so the real library could not tell us a width here even if we
// asked it — what it CAN be held to is the instructions we give it.
vi.mock('react-resizable-panels', async () => {
  const React = await import('react')
  const handle = {
    collapse: () => panel.calls.push('collapse'),
    expand: () => panel.calls.push('expand'),
    resize: (size: number | string) => panel.calls.push(`resize:${size}`),
    getSize: () => ({ asPercentage: 0, inPixels: panel.sizeInPixels }),
    isCollapsed: false,
    isExpanded: true,
  }
  return {
    usePanelRef: () => React.useRef(handle),
    Group: ({ children, ...rest }: Record<string, unknown> & { children?: unknown }) => {
      group.onLayoutChanged = rest.onLayoutChanged as typeof group.onLayoutChanged
      return React.createElement(
        'div',
        { 'data-slot': 'resizable-panel-group', ...pickDom(rest) },
        children as never,
      )
    },
    Panel: ({ children, id, ...rest }: Record<string, unknown> & { children?: unknown; id?: string }) => {
      if (id === 'grid-file-ask-file') declared.current = rest
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
    const label = props['aria-label']
    return {
      ...(className ? { className } : {}),
      ...(style ? { style: style as object } : {}),
      ...(label ? { 'aria-label': label } : {}),
    }
  }
})

import { FilePreviewBridge } from './file-preview-host'
import { FILE_PEEK_WIDTH_MAX, FILE_PEEK_WIDTH_MIN } from '../stores/file-preview-store'

const FILE: FileItem = {
  id: 'doc-1',
  filename: 'Brandschutzplan_EG.pdf',
  displayName: null,
  fileSize: 12,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
}

const reset = (): void => {
  panel.calls = []
  panel.sizeInPixels = 320
  declared.current = null
  group.onLayoutChanged = null
  window.localStorage.clear()
  nav.pathname = '/app/projects/p1/files'
  useFilePreviewStore.setState({
    file: null,
    mode: 'modal',
    hidden: false,
    peekWidth: 320,
    context: {},
  })
}

describe('FilePreviewSplit — the file panel actually opens', () => {
  beforeEach(reset)
  afterEach(reset)

  it('EXPANDS the panel, not just resizes it, when Ask Piloti lands on chat', () => {
    // Exactly the Ask Piloti journey: the peek is opened while still in Files
    // (askAboutFile does this before it navigates), so the bridge mounts with
    // the split OFF and the panel collapsed.
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(panel.calls).toEqual(['collapse'])

    panel.calls = []
    nav.pathname = '/app/projects/p1/chat'
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // `expand` MUST come first and MUST be there at all: a collapsed panel
    // ignores `resize`, which is how the pane ended up 0px wide in a peek that
    // every other assertion called correct.
    expect(panel.calls).toEqual(['expand', 'resize:320'])
  })

  it('declares its size bounds independently of the split flag', () => {
    // Mounted in Files — split OFF. The bounds must ALREADY be the real ones:
    // `defaultSize` is read once at mount and never revisited, and bounds of
    // zero would clamp the expand above back to nothing.
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(declared.current).toMatchObject({
      defaultSize: 320,
      minSize: FILE_PEEK_WIDTH_MIN,
      maxSize: FILE_PEEK_WIDTH_MAX,
      collapsible: true,
      collapsedSize: 0,
    })
  })

  it('does not feed the dragged width back into `defaultSize`', () => {
    // THE BUG THAT MADE THE SEAM IMMOVABLE. `defaultSize` was the live store
    // width and the panel wrote every intermediate width back to that store, so
    // each pointer move re-rendered the group with a new default and the library
    // recomputed the layout from it — on top of the drag in progress. The pane
    // crawled about twenty pixels and stopped, in either direction.
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(declared.current).toMatchObject({ defaultSize: 320 })

    // What a resize does: it commits a width to the store, which re-renders.
    useFilePreviewStore.getState().setPeekWidth(500)
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // The mount value, unmoved. A `defaultSize` that tracks the reader is a
    // `defaultSize` that fights them.
    expect(declared.current).toMatchObject({ defaultSize: 320 })
  })

  it('commits the width once the gesture is over, not once per frame', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // No per-move writer on the panel: `onResize` fires on every pointer move,
    // and this width goes to localStorage.
    expect(declared.current?.onResize).toBeUndefined()

    panel.sizeInPixels = 540
    group.onLayoutChanged?.({}, { isUserInteraction: true })

    expect(useFilePreviewStore.getState().peekWidth).toBe(540)
    expect(window.localStorage.getItem('grid.filePeek.width')).toBe('540')
  })

  it('ignores layout changes it caused itself', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // Expanding, collapsing and re-measuring all change the layout. None of
    // them is the reader choosing a width, and recording them would let a
    // window resize quietly rewrite what they chose.
    panel.sizeInPixels = 540
    group.onLayoutChanged?.({}, { isUserInteraction: false })

    expect(useFilePreviewStore.getState().peekWidth).toBe(320)
    expect(window.localStorage.getItem('grid.filePeek.width')).toBeNull()
  })

  it('treats a seam dragged shut as dismissing the peek', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    panel.sizeInPixels = 0
    group.onLayoutChanged?.({}, { isUserInteraction: true })

    const state = useFilePreviewStore.getState()
    // Same meaning as the ✕ on the peek: the viewer goes away, the question
    // stays. Zero is never a width to remember.
    expect(state.hidden).toBe(true)
    expect(state.file?.id).toBe('doc-1')
    expect(state.peekWidth).toBe(320)
  })

  it('opens at the width the reader left it at in an earlier session', () => {
    window.localStorage.setItem('grid.filePeek.width', '620')
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // Sized from storage in the same commit as the split opens — not left at
    // the default until the reader drags it again.
    expect(panel.calls).toContain('resize:620')
    expect(useFilePreviewStore.getState().peekWidth).toBe(620)
  })

  it('names the seam, which the panel library makes a tab stop', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { getByRole } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    // Arrow keys on this separator resize the pane, so it is a control a
    // keyboard reader arrives at — announced as "separator" and nothing else
    // until someone gives it a name.
    expect(getByRole('separator')).toHaveAttribute('aria-label', 'Resize file preview')
  })

  it('collapses again when the peek is dismissed, so chat reclaims the row', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(panel.calls).toEqual(['expand', 'resize:320'])

    panel.calls = []
    useFilePreviewStore.getState().hide()
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(panel.calls).toEqual(['collapse'])
  })
})
