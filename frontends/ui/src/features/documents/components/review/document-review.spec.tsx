/**
 * The full-screen review around the page layer: the tools as the reader first
 * meets them, the walk through Piloti's proposals, the way out to a window of
 * its own, and the tool the review is opened with.
 *
 * The viewer is a stand-in that lays page 1's overlay and the tools it is
 * handed into its pill, as the real one does: what is pinned here is the
 * review's side of that contract, not PDF rendering.
 */

import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { act, fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { RoomFrame } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { useDocumentReview, type ReviewTool } from '../../hooks/use-document-review'
import type { RoomTransport } from '../../hooks/use-document-room'
import { DocumentReviewMode, TOOLS_INTRO_KEY } from './document-review'

vi.mock('@/features/chat', () => ({
  useChatStore: (selector: (state: { currentUserId: string }) => unknown) => selector({ currentUserId: 'user_me' }),
}))

vi.mock('@/features/knowledge/components/pdf-document-view', () => ({
  PdfDocumentView: ({ pageOverlay, toolbarLead }: { pageOverlay?: (page: number) => ReactNode; toolbarLead?: ReactNode }) => (
    <div>
      <div data-testid="pdf-floating-toolbar">{toolbarLead}</div>
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>{pageOverlay?.(1)}</div>
      </div>
    </div>
  ),
}))

const view = (overrides: Partial<AnnotationView>): AnnotationView => ({
  id: 'ann_1',
  documentId: 'doc_1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 2,
  onCurrentFassung: true,
  createdBy: 'user_me',
  createdByName: 'Miriam Hofer',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
  ...overrides,
})

const room = (): RoomTransport => ({
  connect({ onFrame, onOpen }) {
    onOpen()
    onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } } as RoomFrame)
    return () => {}
  },
  post: () => {},
})

function Host({
  popoutHref,
  initialTool,
  onOpenChange = () => {},
}: {
  popoutHref?: string | null
  initialTool?: ReviewTool
  onOpenChange?: (open: boolean) => void
}) {
  const [transport] = useState(room)
  const review = useDocumentReview('doc_1', { enabled: true, transport })
  return (
    <DocumentReviewMode
      open
      onOpenChange={onOpenChange}
      review={review}
      documentName="Grundriss.pdf"
      canPickAssignee={false}
      popoutHref={popoutHref}
      initialTool={initialTool}
    />
  )
}

const serve = (annotations: AnnotationView[]) =>
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate: true, pilotiWakes: false }))
  )

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the tools', () => {
  it('are spelled out the first time a browser opens a review, and fold for good', async () => {
    serve([])
    const { unmount } = render(<Host />)
    const tools = await screen.findByTestId('review-tools')
    // In the viewer's own pill: one bar at the foot, not two.
    expect(within(screen.getByTestId('pdf-floating-toolbar')).getByTestId('review-tools')).toBe(tools)
    await waitFor(() => expect(tools).toHaveAttribute('data-variant', 'intro'))
    expect(within(tools).getByText('Comment')).toBeInTheDocument()
    expect(within(tools).getByText('Area')).toBeInTheDocument()
    expect(within(tools).getByText('R')).toBeInTheDocument()

    await userEvent.click(within(tools).getByTestId('review-tools-fold'))
    expect(screen.getByTestId('review-tools')).toHaveAttribute('data-variant', 'icons')
    expect(window.localStorage.getItem(TOOLS_INTRO_KEY)).toBe('1')

    unmount()
    render(<Host />)
    expect(await screen.findByTestId('review-tools')).toHaveAttribute('data-variant', 'icons')
  })

  it('arms the tool the review was opened with, and says what it does next', async () => {
    serve([])
    render(<Host initialTool="point" />)
    await waitFor(() => expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByTestId('review-tool-hint')).toHaveTextContent('Click the place · Esc cancels')
  })

  it('keeps the cursor chat apart from the comment tool: its own glyph, and no pointer to open at from its button', async () => {
    serve([])
    render(<Host />)
    await userEvent.click(await screen.findByTestId('review-tool-chat'))
    const bubble = screen.getByTestId('cursor-chat')
    // Opened from the button, not at the corner of the toolbar it was pressed in: a plain bubble.
    expect(bubble.className).not.toContain('rounded-tl-sm')
    const glyph = (testId: string) => screen.getByTestId(testId).querySelector('svg')?.getAttribute('class')
    expect(glyph('review-tool-chat')).not.toEqual(glyph('review-tool-point'))
  })
})

describe('going through the proposals', () => {
  it('says where the proposal in hand stands, and moves on once it is decided', async () => {
    let marks = [
      view({ id: 'p1', number: 1, authorKind: 'piloti', status: 'proposed', body: 'Erster Befund' }),
      view({ id: 'p2', number: 2, authorKind: 'piloti', status: 'proposed', body: 'Zweiter Befund' }),
      view({ id: 'p3', number: 3, authorKind: 'piloti', status: 'proposed', body: 'Dritter Befund' }),
    ]
    serve(marks)
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', ({ params }) => {
        marks = marks.map((mark) => (mark.id === params.annotationId ? { ...mark, status: 'open', acceptedBy: 'user_me' } : mark))
        return HttpResponse.json({ annotation: marks.find((mark) => mark.id === params.annotationId) })
      })
    )
    render(<Host />)

    await userEvent.click(await screen.findByTestId('review-walk-proposals'))
    let thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByTestId('thread-walk')).toHaveTextContent('1/3')
    expect(within(thread).getByText('Erster Befund')).toBeInTheDocument()

    await userEvent.click(within(thread).getByTestId('thread-accept'))
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).getByText('Zweiter Befund')).toBeInTheDocument())
    thread = screen.getByTestId('review-thread')
    expect(within(thread).getByTestId('thread-walk')).toHaveTextContent('1/2')

    await userEvent.click(within(thread).getByTestId('thread-walk-next'))
    expect(within(screen.getByTestId('review-thread')).getByText('Dritter Befund')).toBeInTheDocument()
    expect(screen.getByTestId('thread-walk')).toHaveTextContent('2/2')
  })
})

describe('the review on a page of its own', () => {
  it('opens in a window of its own, and copies its link', async () => {
    serve([])
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Host popoutHref="/projects/p1/files?doc=doc_1&review=1" />)

    await userEvent.click(await screen.findByTestId('review-popout'))
    expect(opened).toHaveBeenCalledWith('/projects/p1/files?doc=doc_1&review=1', '_blank', 'popup,width=1440,height=900')

    await act(async () => {
      await userEvent.click(screen.getByTestId('review-copy-link'))
    })
    expect(writeText).toHaveBeenCalledWith(new URL('/projects/p1/files?doc=doc_1&review=1', window.location.href).toString())
  })

  it('offers neither without a page to open', async () => {
    serve([])
    render(<Host />)
    await screen.findByTestId('review-tools')
    expect(screen.queryByTestId('review-popout')).toBeNull()
    expect(screen.queryByTestId('review-copy-link')).toBeNull()
  })
})

describe('Escape', () => {
  it('steps back one thing at a time through the real dialog: the draft, the tool, the card, then the review', async () => {
    serve([view({ id: 'ann_1' })])
    const onOpenChange = vi.fn()
    render(<Host onOpenChange={onOpenChange} />)
    await screen.findByTestId('review-row')

    await userEvent.keyboard('c')
    const capture = await screen.findByTestId('review-capture')
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    capture.setPointerCapture = () => {}
    fireEvent.pointerDown(capture, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('review-draft')).toBeNull())
    expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('review-tool-point')).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(screen.getByTestId('review-row'))
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('review-thread')).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()

    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

/** A room the test speaks in: what colleagues do arrives as frames. */
function liveRoom() {
  let deliver: ((frame: RoomFrame) => void) | null = null
  const transport: RoomTransport = {
    connect({ onFrame, onOpen }) {
      deliver = onFrame
      onOpen()
      onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } } as RoomFrame)
      return () => {
        deliver = null
      }
    },
    post: () => {},
  }
  return { transport, send: (frame: RoomFrame) => act(() => deliver?.(frame)) }
}

const ANNA = { peerId: 'peer_anna_0001', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }

/** The pane's part: it holds the review and hands it on, and counts how often it is drawn. */
function CountingHost({ transport, renders }: { transport: RoomTransport; renders: { count: number } }) {
  renders.count += 1
  const review = useDocumentReview('doc_1', { enabled: true, transport })
  return (
    <DocumentReviewMode open onOpenChange={() => {}} review={review} documentName="Grundriss.pdf" canPickAssignee={false} />
  )
}

/** What the API was asked to set. */
function servePosts(annotations: AnnotationView[]) {
  const created: Array<Record<string, unknown>> = []
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate: true, pilotiWakes: false })),
    http.post('/api/documents/:id/annotations', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      created.push(body)
      return HttpResponse.json({ annotation: view({ id: 'ann_new', number: 9, ...body }) }, { status: 201 })
    })
  )
  return created
}

describe('a room of pointers', () => {
  it('re-renders neither the host that holds the review nor the review while colleagues move', async () => {
    const restore = installLayoutObservers({ frameWidth: 800 })
    serve([view({ id: 'ann_1' })])
    const room = liveRoom()
    const renders = { count: 0 }
    render(<CountingHost transport={room.transport} renders={renders} />)
    await screen.findByTestId('review-row')
    room.send({ kind: 'event', event: { kind: 'presence', peer: ANNA, state: 'here', ttlMs: 25_000 } } as RoomFrame)
    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.1, y: 0.5 } } } as RoomFrame)
    await waitFor(() => expect(screen.getByTestId('review-company-1').textContent).toContain('Anna Berger'))
    const settled = renders.count

    for (let step = 2; step < 22; step += 1) {
      room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: step / 40, y: 0.5 } } } as RoomFrame)
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    }

    expect(renders.count).toBe(settled)
    // The pointer itself still moved: its own layer drew it.
    expect(screen.getByTestId('review-company-1')).toHaveAttribute('aria-hidden', 'true')
    restore()
  })

  it('listens for its keys once per opening, not once per change', async () => {
    serve([view({ id: 'ann_1', number: 1 }), view({ id: 'ann_2', number: 2, x: 0.6 })])
    const added = vi.spyOn(window, 'addEventListener')
    render(<Host />)
    await screen.findAllByTestId('review-row')
    const keydowns = () => added.mock.calls.filter(([type]) => type === 'keydown').length
    const before = keydowns()

    await userEvent.keyboard('j')
    await userEvent.keyboard('j')
    await userEvent.keyboard('k')
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()

    expect(keydowns()).toBe(before)
  })
})

describe("the keyboard's crosshair", () => {
  it('sets a point with the arrows and Enter, through the same draft a click makes', async () => {
    const created = servePosts([])
    render(<Host />)
    await screen.findByTestId('review-empty')

    await userEvent.keyboard('c')
    const aim = await screen.findByRole('application', { name: /Choose a spot/ })
    await waitFor(() => expect(aim).toHaveFocus())
    expect(screen.getByTestId('review-tool-hint')).toHaveTextContent('Click or ↵ · Arrow keys · Esc')
    // The crosshair's label says the keys in words; the glyph line is not read on top of it.
    expect(screen.getByTestId('review-tool-hint')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('review-tool-hint')).not.toHaveAttribute('role')

    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowDown}{/Shift}')
    expect(aim).toHaveTextContent('Page 1, 53 % from the left, 55 % from the top')
    await userEvent.keyboard('{Enter}')

    const body = await screen.findByTestId('review-draft-body')
    await waitFor(() => expect(body).toHaveFocus())
    // The kinds: three buttons, the one in force pressed (a radio group would owe arrow keys).
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByTestId('thread-kind-hint')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('thread-kind-defect')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.keyboard('Kote fehlt{Enter}')
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ page: 1, shape: 'point', x: 0.53, y: 0.55 })
  })

  it('draws a box: Enter holds a corner, the arrows draw it out, Enter sets it', async () => {
    const created = servePosts([])
    render(<Host />)
    await screen.findByTestId('review-empty')

    await userEvent.keyboard('r')
    const aim = await screen.findByRole('application', { name: /Choose a region/ })
    await waitFor(() => expect(aim).toHaveFocus())
    await userEvent.keyboard('{Enter}{Shift>}{ArrowRight}{ArrowRight}{ArrowDown}{/Shift}')
    expect(screen.getByTestId('review-aim-box')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')

    await userEvent.type(await screen.findByTestId('review-draft-body'), 'Stiege{Enter}')
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ shape: 'region', x: 0.5, y: 0.5, w: 0.1, h: 0.05 })
  })

  it('takes a held Enter as one press: its repeats neither hold a corner nor set a point', async () => {
    serve([])
    render(<Host />)
    await screen.findByTestId('review-empty')
    await userEvent.keyboard('r')
    const aim = await screen.findByRole('application', { name: /Choose a region/ })
    fireEvent.keyDown(aim, { key: 'Enter', repeat: true })
    expect(screen.queryByTestId('review-aim-box')).toBeNull()
    fireEvent.keyDown(aim, { key: 'Enter' })
    expect(screen.getByTestId('review-aim-box')).toBeInTheDocument()
    fireEvent.keyDown(aim, { key: 'Enter', repeat: true })
    expect(screen.queryByTestId('review-draft')).toBeNull()
  })

  it('is not there for a pointer: a tool picked by a click sets its place by a click', async () => {
    serve([])
    render(<Host />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByTestId('review-tool-point'))
    expect(screen.queryByTestId('review-aim')).toBeNull()
  })
})

describe('the focus', () => {
  it('goes into a card a key opened, and back to what had it when the card closes', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Host />)
    const trigger = await screen.findByTestId('review-filter-mine')
    trigger.focus()

    await userEvent.keyboard('j')
    const card = await screen.findByTestId('review-thread')
    await waitFor(() => expect(card).toHaveFocus())

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('review-thread')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('goes into the card of a pin opened with Enter', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Host />)
    const pin = await screen.findByTestId('review-pin')
    pin.focus()
    fireEvent.click(pin, { detail: 0 })
    const card = await screen.findByTestId('review-thread')
    await waitFor(() => expect(card).toHaveFocus())
  })

  it('takes the focus on the card itself, so the Enter after J resolves nothing by accident', async () => {
    const patched: unknown[] = []
    serve([view({ id: 'ann_1' })])
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json({ annotation: view({ id: 'ann_1', status: 'resolved' }) })
      })
    )
    render(<Host />)
    await screen.findByTestId('review-row')

    await userEvent.keyboard('j')
    const card = await screen.findByRole('dialog', { name: /Defect\s*#1/ })
    await waitFor(() => expect(card).toHaveFocus())
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(patched).toEqual([])
    expect(screen.getByTestId('thread-resolve')).toBeInTheDocument()
  })

  it('answers a key that lands on the card already open at once, and leaves nothing for a later click to take', async () => {
    serve([view({ id: 'ann_1', number: 1 }), view({ id: 'ann_2', number: 2, x: 0.7 })])
    render(<Host />)
    const rows = await screen.findAllByTestId('review-row')
    // Enter on a row opens its card, then Enter on the same row again: the card is already open.
    fireEvent.click(rows[0] as HTMLElement, { detail: 0 })
    await waitFor(() => expect(screen.getByTestId('review-thread')).toHaveFocus())
    fireEvent.click(rows[0] as HTMLElement, { detail: 0 })
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))

    // Then a pointer opens another mark: the focus stays with the pin it clicked.
    const pin = screen.getAllByTestId('review-pin').find((node) => node.getAttribute('aria-label')?.startsWith('Annotation 2'))
    await userEvent.click(pin as HTMLElement)
    await waitFor(() => expect(screen.getByRole('dialog', { name: /#2/ })).toBeInTheDocument())
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(screen.getByTestId('review-thread')).not.toHaveFocus()
  })

  it('stays where a pointer put it: a card opened by a click takes nothing', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Host />)
    await userEvent.click(await screen.findByTestId('review-pin'))
    const card = await screen.findByTestId('review-thread')
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(card.contains(document.activeElement)).toBe(false)
  })
})

describe('pins and cards to a screen reader', () => {
  it('a pin says its state and opens a dialog; the card is named by its header', async () => {
    serve([
      view({ id: 'ann_1', number: 1 }),
      view({ id: 'ann_p', number: 2, x: 0.6, authorKind: 'piloti', status: 'proposed', createdByName: 'Miriam Hofer' }),
    ])
    render(<Host />)
    const pins = await screen.findAllByTestId('review-pin')
    const proposal = pins.find((pin) => pin.getAttribute('aria-label')?.startsWith('Annotation 2'))
    expect(proposal?.getAttribute('aria-label')).toContain('proposal')
    expect(proposal).toHaveAttribute('aria-haspopup', 'dialog')
    expect(proposal).toHaveAttribute('aria-expanded', 'false')
    expect(proposal).not.toHaveAttribute('aria-pressed')

    await userEvent.click(pins[0] as HTMLElement)
    expect(await screen.findByRole('dialog', { name: /Defect\s*#1/ })).toBeInTheDocument()
    expect(pins[0]).toHaveAttribute('aria-expanded', 'true')
  })

  it('the list filter and the kinds are buttons that say which is on, not tabs or radios without arrow keys', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Host />)
    await screen.findByTestId('review-row')
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByTestId('review-filter-open')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('review-filter-closed')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('the tools spelled out, on a narrow stage', () => {
  it('fold to their glyphs under ~1000px of stage, the names kept for a screen reader', async () => {
    serve([])
    render(<Host />)
    const point = await screen.findByTestId('review-tool-point')
    expect(screen.getByTestId('review-tools')).toHaveAttribute('data-variant', 'intro')
    expect(point).toHaveAccessibleName('Comment')
    expect(point.className).toMatch(/@max-5xl:w-7/)
    const label = within(point).getByText((_, node) => node?.tagName === 'SPAN' && node.className.includes('@max-5xl:sr-only'))
    expect(label).toBeInTheDocument()
    // Folded, the glyph still says its name and key where a pointer finds it: the icons' tooltip.
    await userEvent.hover(point)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Comment\s*C/)
  })
})
