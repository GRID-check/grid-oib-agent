import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useFilePreviewStore } from '../stores/file-preview-store'
import type { FileItem } from './project-file-workspace'

const pane = vi.hoisted(() => ({ mounts: 0 }))
const nav = vi.hoisted(() => ({ pathname: '/app/projects/p1/files' }))
const layout = vi.hoisted(() => ({ rightPanel: null as string | null }))
const mobile = vi.hoisted(() => ({ is: false }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}))

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => mobile.is,
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: (selector: (state: { rightPanel: string | null }) => unknown) =>
    selector({ rightPanel: layout.rightPanel }),
}))

vi.mock('./file-preview-pane', async () => {
  const React = await import('react')
  return {
    FilePreviewPane: function FilePreviewPaneMock() {
      React.useEffect(() => {
        pane.mounts += 1
      }, [])
      // Two focusables, so the focus trap has something to cycle between —
      // the real pane is full of them (download, menu, tags, retry).
      return React.createElement('div', { 'data-testid': 'file-preview-pane' }, [
        React.createElement('button', { key: 'a', type: 'button' }, 'pane first'),
        React.createElement('button', { key: 'b', type: 'button' }, 'pane last'),
      ])
    },
  }
})

import { FilePreviewBridge, FilePreviewHost, useFilePeekBesideChat } from './file-preview-host'

const FILE: FileItem = {
  id: 'doc-1',
  filename: 'model.ifc',
  displayName: null,
  fileSize: 12,
  contentType: 'application/x-step',
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

describe('FilePreviewHost', () => {
  beforeEach(() => {
    pane.mounts = 0
    nav.pathname = '/app/projects/p1/files'
    layout.rightPanel = null
    mobile.is = false
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      handoff: false,
      peekWidth: 320,
      context: {},
    })
  })

  afterEach(() => {
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekWidth: 320,
      context: {},
    })
  })

  it('keeps the pane mounted (parked) when Ask flips to peek while still on Files', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(<FilePreviewHost />)

    expect(screen.getByTestId('file-preview-pane')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(pane.mounts).toBe(1)
  })

  it('does not remount the pane when the chat route lands', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(pane.mounts).toBe(1)
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')

    nav.pathname = '/app/projects/p1/chat'
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(pane.mounts).toBe(1)
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'peek')
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
  })

  it('peeks as a split pane so chat children stay visible', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'peek')
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('still shows the Files modal and unmounts only when the file is closed', () => {
    useFilePreviewStore.getState().open(FILE, 'modal', { projectId: 'p1' })
    const { rerender } = render(<FilePreviewHost />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'modal')

    useFilePreviewStore.getState().close()
    rerender(<FilePreviewHost />)

    expect(screen.queryByTestId('file-preview-host')).not.toBeInTheDocument()
  })

  it('does not show peek chrome on Settings after Ask; the pane stays parked', () => {
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    nav.pathname = '/app/projects/p1/settings'
    render(<FilePreviewHost />)

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-preview-pane')).toBeInTheDocument()
  })

  it('hides the split and parks the pane without dropping the file', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    const { rerender } = render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    useFilePreviewStore.getState().hide()
    rerender(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(pane.mounts).toBe(1)
  })

  it('expands on chat as a dialog overlay, not a split', () => {
    nav.pathname = '/app/projects/p1/chat'
    useFilePreviewStore.getState().open(FILE, 'expanded', { projectId: 'p1' })
    render(
      <FilePreviewBridge>
        <div>chat transcript</div>
      </FilePreviewBridge>,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'expanded')
    expect(screen.getByText('chat transcript')).toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  describe('the peek says what the reader needs to know', () => {
    const peekOnChat = (status: string): void => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open({ ...FILE, status }, 'peek', { projectId: 'p1' })
    }

    it('carries the status of a file the agent cannot cite yet', () => {
      peekOnChat('processing')
      render(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      // The peek exists BECAUSE this file is what the next question is about.
      // "Still indexing" is the difference between an answer and an apology,
      // and the peek used to be the one surface that did not say it. The
      // CONSEQUENCE is the assertion, not the badge: "Processing" is a word,
      // "Piloti cannot cite this file yet" is the reason the reader is about
      // to get a worse answer than they expect.
      expect(screen.getByRole('status')).toHaveTextContent(/cannot cite this file until it is indexed/i)
    })

    it('stays quiet about a file that is ready', () => {
      peekOnChat('ready')
      render(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      // Quiet chrome is the point of the peek: a strip saying "fine" on every
      // document is a strip nobody reads when it says something else.
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('settles a still-indexing file on screen instead of leaving a stale badge', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'doc-1', status: 'ready' }),
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.useFakeTimers()
      try {
        peekOnChat('processing')
        render(
          <FilePreviewBridge>
            <div>chat transcript</div>
          </FilePreviewBridge>,
        )

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000)
        })

        expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/status')
        expect(useFilePreviewStore.getState().file?.status).toBe('ready')
      } finally {
        vi.useRealTimers()
        vi.unstubAllGlobals()
      }
    })
  })

  describe('dismissing the peek', () => {
    const renderPeekWithUndo = (): void => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      render(
        <FilePreviewBridge>
          <div>chat transcript</div>
          {/* Stands in for the composer's "Asking about …" bar, which is what
              appears in the same commit the peek goes away in. */}
          <button type="button" data-testid="composer-show-file">
            Datei anzeigen
          </button>
        </FilePreviewBridge>,
      )
    }

    it('answers Escape from inside the pane', async () => {
      renderPeekWithUndo()
      const close = screen.getByRole('button', { name: /close preview/i })
      close.focus()

      await act(async () => {
        fireEvent.keyDown(close, { key: 'Escape' })
      })

      expect(useFilePreviewStore.getState().hidden).toBe(true)
      // Hidden, not closed: the conversation is still about this file.
      expect(useFilePreviewStore.getState().file?.id).toBe('doc-1')
    })

    it('ignores Escape pressed outside it', async () => {
      renderPeekWithUndo()

      await act(async () => {
        fireEvent.keyDown(screen.getByText('chat transcript'), { key: 'Escape' })
      })

      // The peek is not modal. A composer Escape (clearing a mention picker,
      // say) must not take the reader's document away.
      expect(useFilePreviewStore.getState().hidden).toBe(false)
    })

    it('hands focus to the control that undoes it', async () => {
      renderPeekWithUndo()
      const close = screen.getByRole('button', { name: /close preview/i })
      close.focus()

      await act(async () => {
        fireEvent.click(close)
        // The move is deferred one frame — the button it comes from is still
        // being removed.
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      })

      expect(document.activeElement).toBe(screen.getByTestId('composer-show-file'))
    })
  })

  describe('the pane announces its own arrival', () => {
    const renderBridge = () =>
      render(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

    it('animates on every arrival, not only the first', () => {
      // It cannot be a plain entrance class: this element survives parked →
      // peek on purpose (an IFC camera hangs off it), and a CSS animation only
      // runs when it is newly APPLIED. A class sitting on a mounted element
      // fires once in the life of the project shell.
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      const { rerender } = renderBridge()
      const host = () => screen.getByTestId('file-preview-host')
      expect(host().className).not.toContain('animate-in')

      nav.pathname = '/app/projects/p1/chat'
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )
      expect(host().className).toContain('animate-in')

      // Cleared when it ends, so the next arrival can re-apply it. (Under
      // reduced motion the global rule collapses the duration to 0.01ms, so
      // the end event still lands and this still clears.)
      fireEvent.animationEnd(host())
      expect(host().className).not.toContain('animate-in')

      useFilePreviewStore.getState().hide()
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )
      useFilePreviewStore.getState().peek()
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      expect(host().className).toContain('animate-in')
    })

    it('animates when a citation swaps one document for another', () => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      const { rerender } = renderBridge()
      fireEvent.animationEnd(screen.getByTestId('file-preview-host'))

      useFilePreviewStore.getState().open({ ...FILE, id: 'doc-2' }, 'peek', { projectId: 'p1' })
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      // Nothing else says the pane is showing a different document — the
      // toolbar's name changes and the well reloads, both silently.
      expect(screen.getByTestId('file-preview-host').className).toContain('animate-in')
    })
  })

  describe('the enlarged view keeps the promise `aria-modal` makes', () => {
    const renderExpanded = () => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open(FILE, 'expanded', { projectId: 'p1' })
      render(
        <FilePreviewBridge>
          <button type="button">behind the scrim</button>
        </FilePreviewBridge>,
      )
    }

    it('wraps Tab at the end back to the beginning', () => {
      renderExpanded()
      const last = screen.getByRole('button', { name: 'pane last' })
      last.focus()

      fireEvent.keyDown(document, { key: 'Tab' })

      // It dims the page and says `aria-modal`, and then let Tab walk out into
      // the chat, the composer and the nav rail — everything behind the dim,
      // none of it reachable by pointer, all of it reachable by keyboard.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'pane first' }))
    })

    it('wraps Shift+Tab at the beginning back to the end', () => {
      renderExpanded()
      const first = screen.getByRole('button', { name: 'pane first' })
      first.focus()

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'pane last' }))
    })

    it('leaves Tab alone in the peek, which is not modal', () => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      render(
        <FilePreviewBridge>
          <button type="button">in the conversation</button>
        </FilePreviewBridge>,
      )
      const outside = screen.getByRole('button', { name: 'in the conversation' })
      outside.focus()

      fireEvent.keyDown(document, { key: 'Tab' })

      // The peek sits BESIDE the conversation. Trapping there would strand a
      // keyboard reader in a viewer they did not open modally.
      expect(document.activeElement).toBe(outside)
    })
  })

  describe('carrying the file from Files to the conversation', () => {
    it('holds the viewer open while the router is still moving', () => {
      // Exactly what Ask Piloti does: set the DESTINATION's mode, mark the
      // handoff, then navigate. The pathname is still Files for as long as the
      // navigation takes.
      useFilePreviewStore.getState().open(FILE, 'modal', { projectId: 'p1' })
      const { rerender } = render(<FilePreviewHost />)
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      act(() => {
        useFilePreviewStore.getState().peek()
        useFilePreviewStore.getState().beginHandoff()
      })
      rerender(<FilePreviewHost />)

      // Not parked. The reader's document stays where they left it — and as
      // what they left it: a `peek` presentation inside a dialog would be a
      // headerless body floating in the middle of the Files page.
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'peek')
      expect(pane.mounts).toBe(1)
    })

    it('hands over the moment the conversation is on screen, and lets go', () => {
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      act(() => useFilePreviewStore.getState().beginHandoff())
      const { rerender } = render(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      nav.pathname = '/app/projects/p1/chat'
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

      expect(screen.getByRole('complementary')).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      // Let go, or the next walk to another section would hold a dialog up
      // over it on the strength of a journey that finished long ago.
      expect(useFilePreviewStore.getState().handoff).toBe(false)
      expect(pane.mounts).toBe(1)
    })

    it('still parks when the reader simply walks away', () => {
      // Same store state as the handoff — `peek` while off-chat — and the
      // opposite intent. Nobody said they were taking the file anywhere.
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      nav.pathname = '/app/projects/p1/settings'
      render(<FilePreviewHost />)

      expect(screen.getByTestId('file-preview-host')).toHaveAttribute('data-mode', 'parked')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('no gesture on this surface is one-way', () => {
    const renderSplit = () =>
      render(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )

    beforeEach(() => {
      nav.pathname = '/app/projects/p1/chat'
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
    })

    it('leaves a way back at the edge the document went out through', async () => {
      const { rerender } = renderSplit()
      expect(screen.queryByTestId('file-peek-restore')).not.toBeInTheDocument()

      // However it was dismissed — ✕, Escape, or the seam dragged shut — the
      // reader looks for the pane where they last saw it.
      useFilePreviewStore.getState().hide()
      rerender(
        <FilePreviewBridge>
          <div>chat transcript</div>
        </FilePreviewBridge>,
      )
      const restore = screen.getByTestId('file-peek-restore')
      expect(restore).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(restore)
      })

      expect(useFilePreviewStore.getState().hidden).toBe(false)
      expect(screen.getByRole('complementary')).toBeInTheDocument()
      expect(screen.queryByTestId('file-peek-restore')).not.toBeInTheDocument()
    })

    it('does not leave one where the pane could not have been anyway', () => {
      // Nothing was dismissed on Files — the pane is parked because the reader
      // walked away from the conversation, and a tab there would offer to undo
      // something nobody did.
      nav.pathname = '/app/projects/p1/files'
      renderSplit()

      expect(screen.queryByTestId('file-peek-restore')).not.toBeInTheDocument()
    })
  })

  describe('useFilePeekBesideChat — the one answer to "is the file on screen?"', () => {
    const Probe = (): JSX.Element => (
      <span data-testid="beside">{String(useFilePeekBesideChat())}</span>
    )
    const answer = (): string => screen.getByTestId('beside').textContent ?? ''

    beforeEach(() => {
      useFilePreviewStore.getState().open(FILE, 'peek', { projectId: 'p1' })
      nav.pathname = '/app/projects/p1/chat'
    })

    it('is true for a peek beside the conversation', () => {
      render(<Probe />)
      expect(answer()).toBe('true')
    })

    it.each([
      ['the research panel holds that half of the row', () => { layout.rightPanel = 'research' }],
      ['the reader is on a phone', () => { mobile.is = true }],
      ['the reader has walked to another section', () => { nav.pathname = '/app/projects/p1/files' }],
      ['the peek was dismissed', () => useFilePreviewStore.getState().hide()],
    ])('is false when %s', (_label, arrange) => {
      arrange()
      render(<Probe />)

      // Each of these takes the pane off screen without touching `mode` or
      // `hidden`, which is exactly what the composer bar used to ask — so it
      // withheld "Show file" in three states where nothing was visible.
      expect(answer()).toBe('false')
    })
  })
})
