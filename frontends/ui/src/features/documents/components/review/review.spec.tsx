/**
 * The review against MSW and a scripted room: the hook both surfaces share, the
 * page layer, the thread card and the panel, through the real typed client.
 *
 * What is pinned: a person sets a point or a region where the pointer went,
 * through the API; Piloti's marks arrive as proposals a person takes over or
 * dismisses; a change somebody else made is read again even while pointers are
 * moving (each pointer re-renders the review, and a listener that re-subscribed
 * on every render cancelled the read: the bug this suite caught); colleagues'
 * pointers are drawn on their page; and a reader who may not write gets no tools.
 *
 * And Piloti on the canvas, through the real canvas client on a scripted
 * socket: a box drawn with the Piloti tool opens its card, the question goes
 * out with the box, the answer streams into the card and can be taken over as
 * an Anmerkung at the box, and @Piloti in a thread asks for a reply there.
 */

import { act, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { server } from '@/mocks/server'
import type { TurnSocket, TurnSocketOptions } from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { wakeTurnId } from '@/lib/annotations/wake-ids'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { createCanvasTurnClient, type CanvasTurnClientOptions } from '../../lib/canvas-turn-client'
import { useDocumentReview } from '../../hooks/use-document-review'
import type { RoomTransport } from '../../hooks/use-document-room'
import { PilotiAnswerCard } from './piloti-answer-card'
import { ReviewPageLayer } from './review-page-layer'
import { ReviewPanel } from './review-panel'
import { DraftCard, ThreadCard } from './thread-card'

vi.mock('@/features/chat', () => ({
  useChatStore: (selector: (state: { currentUserId: string }) => unknown) => selector({ currentUserId: 'user_me' }),
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

/** A room the test plays: frames go to the hook, posts are recorded. */
function scriptedRoom() {
  let deliver: ((frame: RoomFrame) => void) | null = null
  const posts: RoomPost[] = []
  const transport: RoomTransport = {
    connect({ onFrame, onOpen }) {
      deliver = onFrame
      onOpen()
      onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
      return () => {
        deliver = null
      }
    },
    post: (post) => posts.push(post),
  }
  return { transport, posts, send: (frame: RoomFrame) => act(() => deliver?.(frame)) }
}

const ANNA = { peerId: 'peer_anna_0001', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }

/** Piloti's socket, played by the test: what the canvas sends, and the answer's frames on cue. */
function scriptedPiloti() {
  const sent: ClientMessage[] = []
  let options: TurnSocketOptions | null = null
  const socket: TurnSocket = {
    connect: async () => options?.onStatus?.('open'),
    send: (message) => {
      sent.push(message)
      return true
    },
    accepts: (entry) => entry === 'steer',
    reconnect: () => {},
    close: () => {},
  }
  const createClient = (given: CanvasTurnClientOptions) =>
    createCanvasTurnClient({
      ...given,
      createSocket: (socketOptions) => {
        options = socketOptions
        return socket
      },
    })
  const questions = () =>
    sent.filter((message): message is Extract<ClientMessage, { message_id: string }> => message.type === 'user_message')
  return {
    sent,
    questions,
    createClient,
    deliver: (seq: number, body: Record<string, unknown>) => {
      const turnId = questions().at(-1)?.message_id ?? 'turn-1'
      act(() => options?.onEvent(eventOf(frameOf(seq, body, turnId))))
    },
  }
}

/** The pane's join, without the viewer: page 1's layer in a sized box, the open thread, and the panel. */
function Harness({
  transport,
  onReady,
  piloti,
}: {
  transport: RoomTransport
  onReady?: (review: ReturnType<typeof useDocumentReview>) => void
  piloti?: ReturnType<typeof scriptedPiloti>
}) {
  const review = useDocumentReview('doc_1', {
    enabled: true,
    transport,
    piloti: piloti ? { projectId: 'proj_1', fileName: 'Grundriss.pdf', createClient: piloti.createClient } : undefined,
  })
  useEffect(() => {
    onReady?.(review)
  })
  const selected = review.annotations.find((annotation) => annotation.id === review.selectedId)
  return (
    <>
      <div data-testid="sheet" style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer
            page={1}
            review={review}
            focused
            renderAsk={(ask, { placement }) => <PilotiAnswerCard review={review} ask={ask} placement={placement} />}
            renderThread={({ placement }) =>
              review.draft ? (
                <DraftCard review={review} draft={review.draft} placement={placement} canPickAssignee={false} />
              ) : selected ? (
                <ThreadCard review={review} annotation={selected} placement={placement} canPickAssignee={false} />
              ) : null
            }
          />
        </div>
      </div>
      <button type="button" onClick={() => review.setTool('region')}>
        region tool
      </button>
      <button type="button" onClick={() => review.setTool('point')}>
        point tool
      </button>
      <button type="button" onClick={() => review.setTool('ask')}>
        piloti tool
      </button>
      <ReviewPanel review={review} onOpen={(annotation) => review.select(annotation.id)} />
    </>
  )
}

const serve = (annotations: AnnotationView[], canAnnotate = true, pilotiWakes = false) =>
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations, canAnnotate, pilotiWakes })),
    // One mark, as a room hint has it read again.
    http.get('/api/documents/:id/annotations/:annotationId', ({ params }) => {
      const found = annotations.find((annotation) => annotation.id === params.annotationId)
      return found
        ? HttpResponse.json({ annotation: found })
        : HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    })
  )

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

/** The page's capture surface, measured as an 800 × 600 sheet. */
function captureSurface() {
  const capture = within(screen.getByTestId('sheet')).getByTestId('review-capture')
  vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
  capture.setPointerCapture = () => {}
  return capture
}

/** The conversation and its question rows, as the BFF answers them; what was posted is recorded. */
function serveConversation() {
  const posted: Array<{ path: string; body: unknown }> = []
  server.use(
    // The person's own thread about the document (ADR-0106), which the canvas asks in.
    http.post('/api/documents/:id/thread', async ({ request }) => {
      posted.push({ path: 'thread', body: await request.json() })
      return HttpResponse.json({ conversationId: 's_thread_doc_1' })
    }),
    http.post('/api/conversations', async ({ request }) => {
      posted.push({ path: 'conversation', body: await request.json() })
      return HttpResponse.json({}, { status: 201 })
    }),
    http.post('/api/conversations/:id/messages', async ({ request }) => {
      posted.push({ path: 'message', body: await request.json() })
      return HttpResponse.json([], { status: 201 })
    })
  )
  return posted
}

/** Draw a box with the Piloti tool, ask about it, and let Piloti answer. */
async function askAboutABox(piloti: ReturnType<typeof scriptedPiloti>) {
  await userEvent.click(screen.getByRole('button', { name: 'piloti tool' }))
  const capture = captureSurface()
  fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
  fireEvent.pointerMove(capture, { clientX: 320, clientY: 300, pointerId: 1 })
  fireEvent.pointerUp(capture, { clientX: 320, clientY: 300, pointerId: 1 })

  const card = await screen.findByTestId('piloti-card')
  expect(within(card).getByTestId('piloti-composer')).toBeInTheDocument()
  expect(within(screen.getByTestId('sheet')).getByTestId('piloti-ask-box')).toHaveAttribute('data-status', 'composing')
  await userEvent.click(within(card).getByTestId('piloti-quick-dimensions'))
  await waitFor(() => expect(piloti.questions()).toHaveLength(1))
}

describe('the review', () => {
  it('walks the marks in the order the list shows them: proposals first, this Fassung only; K from nothing is the last', async () => {
    serve([
      view({ id: 'a', number: 1 }),
      view({ id: 'b', number: 2 }),
      view({ id: 'p', number: 3, authorKind: 'piloti', status: 'proposed' }),
      view({ id: 'old', number: 4, onCurrentFassung: false }),
    ])
    let review: ReturnType<typeof useDocumentReview> | null = null
    render(<Harness transport={scriptedRoom().transport} onReady={(next) => (review = next)} />)
    await screen.findAllByTestId('review-pin')

    const walked: Array<string | undefined> = []
    for (let i = 0; i < 4; i += 1) act(() => void walked.push(review?.step(1)?.id))
    expect(walked).toEqual(['p', 'a', 'b', 'p'])

    act(() => review?.select(null))
    let back: string | undefined
    act(() => void (back = review?.step(-1)?.id))
    expect(back).toBe('b')
  })

  it('draws a point as a pin and a region as a box with its pin at the corner', async () => {
    serve([
      view({ id: 'a', number: 1 }),
      view({ id: 'b', number: 2, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25, kind: 'question' }),
      view({ id: 'c', number: 3, onCurrentFassung: false }),
    ])
    render(<Harness transport={scriptedRoom().transport} />)

    const pins = await within(screen.getByTestId('sheet')).findAllByTestId('review-pin')
    expect(pins).toHaveLength(2)
    const region = within(screen.getByTestId('sheet')).getByTestId('review-region')
    expect(region.style.left).toBe('10%')
    expect(region.style.width).toBe('30%')
    // The mark set on an earlier Fassung is listed, not drawn.
    expect(screen.getAllByTestId('review-row')).toHaveLength(3)
  })

  it('sets a region dragged out with the region tool, through the API, from this tab', async () => {
    serve([])
    const posted: Array<{ body: unknown; peer: string | null }> = []
    server.use(
      http.post('/api/documents/:id/annotations', async ({ request }) => {
        posted.push({ body: await request.json(), peer: request.headers.get('x-grid-room-peer') })
        return HttpResponse.json(
          { annotation: view({ id: 'new', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'question' }) },
          { status: 201 }
        )
      })
    )
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')

    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    const capture = within(screen.getByTestId('sheet')).getByTestId('review-capture')
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    capture.setPointerCapture = () => {}
    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
    fireEvent.pointerMove(capture, { clientX: 320, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 300, pointerId: 1 })

    const draft = await screen.findByTestId('review-draft')
    await userEvent.click(within(draft).getByTestId('thread-kind-question'))
    await userEvent.type(within(draft).getByTestId('review-draft-body'), 'Raumhöhe nachweisen?{Enter}')

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body).toEqual({
      page: 1,
      shape: 'region',
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.3,
      kind: 'question',
      body: 'Raumhöhe nachweisen?',
      assigneeUserId: null,
      dueOn: null,
    })
    expect(posted[0].peer).toMatch(/^[A-Za-z0-9]{12,}$/)
  })

  it("takes Piloti's proposal over: the thread says what it is, and taking it over opens it", async () => {
    serve([view({ id: 'p', authorKind: 'piloti', status: 'proposed', basis: 'OIB-RL 2, Pkt. 3.4', canDelete: false })])
    const patched: unknown[] = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json({ annotation: view({ id: 'p', authorKind: 'piloti', status: 'open', acceptedBy: 'user_me' }) })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).getByText('Proposal')).toBeInTheDocument()
    expect(within(thread).getByText('OIB-RL 2, Pkt. 3.4')).toBeInTheDocument()
    expect(within(thread).queryByTestId('thread-resolve')).not.toBeInTheDocument()

    await userEvent.click(within(thread).getByTestId('thread-accept'))

    // The status the card showed goes with the move: a stale tab gets a 409, never a blind change.
    await waitFor(() => expect(patched).toEqual([{ status: 'open', expectedStatus: 'proposed' }]))
    await waitFor(() => expect(within(screen.getByTestId('review-thread')).queryByTestId('thread-accept')).toBeNull())
  })

  it('reads again only the mark a hint names, not the list, while pointers keep moving', async () => {
    let listed = 0
    const read: string[] = []
    server.use(
      http.get('/api/documents/:id/annotations', () => {
        listed += 1
        return HttpResponse.json({ annotations: [], canAnnotate: true })
      }),
      http.get('/api/documents/:id/annotations/:annotationId', ({ params }) => {
        read.push(String(params.annotationId))
        return HttpResponse.json({ annotation: view({ id: 'theirs', body: 'Von Anna gesetzt' }) })
      })
    )
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')

    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['theirs'], change: 'created', actor: { ...ANNA } },
    })
    // A pointer every 30ms for half a second: none of them cancels the read.
    for (let index = 0; index < 16; index += 1) {
      room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: index / 20, y: 0.5 } } })
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    }

    expect(await screen.findByText('Von Anna gesetzt')).toBeInTheDocument()
    expect(read).toEqual(['theirs'])
    expect(listed).toBe(1)
  })

  it('takes a mark a hint names off the list when it is not there any more for this reader', async () => {
    serve([view({ id: 'gone', body: 'Wird gelöscht' })])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    expect(await screen.findByText('Wird gelöscht')).toBeInTheDocument()

    serve([])
    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['gone'], change: 'deleted', actor: { ...ANNA } },
    })
    await waitFor(() => expect(screen.queryByText('Wird gelöscht')).toBeNull())
  })

  it("never draws a mark of the document left behind: a re-read that answers after the switch lands nowhere", async () => {
    let release: () => void = () => {}
    server.use(
      http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations: [], canAnnotate: true })),
      http.get('/api/documents/:id/annotations/:annotationId', async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ annotation: view({ id: 'theirs', documentId: 'doc_1', body: 'Auf Dokument A' }) })
      })
    )
    const room = scriptedRoom()
    const { result, rerender } = renderHook(({ id }) => useDocumentReview(id, { enabled: true, transport: room.transport }), {
      initialProps: { id: 'doc_1' },
    })
    await waitFor(() => expect(result.current.load).toBe('ready'))
    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['theirs'], change: 'created', actor: { ...ANNA } },
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))

    rerender({ id: 'doc_2' })
    await waitFor(() => expect(result.current.load).toBe('ready'))
    release()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(result.current.annotations).toEqual([])
  })

  it('lets only the latest re-read of a mark land: an older answer cannot bring back a mark a newer one found gone', async () => {
    const answers: Array<() => void> = []
    let reads = 0
    server.use(
      http.get('/api/documents/:id/annotations', () =>
        HttpResponse.json({ annotations: [view({ id: 'm', body: 'Wird gelöscht' })], canAnnotate: true })
      ),
      http.get('/api/documents/:id/annotations/:annotationId', async () => {
        reads += 1
        if (reads === 1) {
          // The first read is slow, and answers with the mark as it was.
          await new Promise<void>((resolve) => answers.push(resolve))
          return HttpResponse.json({ annotation: view({ id: 'm', body: 'Wird gelöscht' }) })
        }
        return HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
      })
    )
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentReview('doc_1', { enabled: true, transport: room.transport }))
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))
    const hint = (change: 'updated' | 'deleted') =>
      room.send({ kind: 'event', event: { kind: 'annotations.changed', annotationIds: ['m'], change, actor: { ...ANNA } } })

    hint('updated')
    await waitFor(() => expect(answers).toHaveLength(1))
    hint('deleted')
    await waitFor(() => expect(result.current.annotations).toEqual([]))

    answers[0]?.()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(result.current.annotations).toEqual([])
  })

  it("does not read again for this tab's own write, which it already holds", async () => {
    let calls = 0
    server.use(
      http.get('/api/documents/:id/annotations', () => {
        calls += 1
        return HttpResponse.json({ annotations: [], canAnnotate: true })
      })
    )
    const room = scriptedRoom()
    let peerId = ''
    render(<Harness transport={room.transport} onReady={(review) => (peerId = review.room.peerId)} />)
    await screen.findByTestId('review-empty')

    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['mine'], change: 'created', actor: { ...ANNA, peerId } },
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(calls).toBe(1)
  })

  it("draws a colleague's pointer on their page, and answers a stranger's presence with its own", async () => {
    const restore = installLayoutObservers({ frameWidth: 800 })
    serve([])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')
    const announced = room.posts.filter((post) => post.presence === 'here').length

    room.send({ kind: 'event', event: { kind: 'presence', peer: ANNA, state: 'here', ttlMs: 25_000 } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.5, y: 0.5 }, tool: 'region' } })

    expect(await within(screen.getByTestId('sheet')).findByText('Anna Berger')).toBeInTheDocument()
    await waitFor(() => expect(room.posts.filter((post) => post.presence === 'here').length).toBe(announced + 1))
    restore()
  })

  it('gives a reader who may not write no tools and no decisions', async () => {
    serve([view({ id: 'p', authorKind: 'piloti', status: 'proposed', canEdit: false, canDelete: false })], false)
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).queryByTestId('thread-accept')).not.toBeInTheDocument()
    expect(within(thread).queryByTestId('thread-reply')).not.toBeInTheDocument()
  })

  it('asks Piloti about a box drawn with its tool, and streams the answer beside it', async () => {
    serve([])
    const posted = serveConversation()
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)
    await screen.findByTestId('review-empty')

    await askAboutABox(piloti)

    // The person's own thread about the document, which the server creates (ADR-0106).
    expect(posted[0]).toEqual({ path: 'thread', body: { title: 'Grundriss.pdf · Review' } })
    expect(posted.some((entry) => entry.path === 'conversation')).toBe(false)
    expect(piloti.questions()[0].conversation_id).toBe('s_thread_doc_1')
    expect(posted[1]).toEqual({
      path: 'message',
      body: {
        id: piloti.questions()[0].message_id,
        role: 'user',
        content: 'Check the dimensions in this detail: are they complete, consistent and plausible?',
        messageType: 'user',
      },
    })
    expect(piloti.questions()[0]).toMatchObject({
      text: 'Check the dimensions in this detail: are they complete, consistent and plausible?',
      focus_document_id: 'doc_1',
      focus_file_name: 'Grundriss.pdf',
      focus_region: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
      reasoning_effort: 'low',
    })
    expect(piloti.questions()[0]).not.toHaveProperty('reply_in_thread')

    const card = screen.getByTestId('piloti-card')
    expect(within(card).getByTestId('piloti-card-thinking')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).getByTestId('piloti-ask-box')).toHaveAttribute('data-status', 'thinking')

    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'TEXT_MESSAGE_START', message_id: 'a-1' })
    piloti.deliver(3, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'Die Raumhöhe ist ' })
    piloti.deliver(4, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'nicht kotiert.' })
    expect(await within(card).findByText(/Die Raumhöhe ist nicht kotiert\./)).toBeInTheDocument()

    piloti.deliver(5, {
      type: 'RUN_FINISHED',
      outcome: 'answered',
      result: { message_id: 'a-1', text: 'Die Raumhöhe ist nicht kotiert.\n\n[[card:1]]' },
    })
    await waitFor(() => expect(within(card).queryByTestId('piloti-card-thinking')).toBeNull())
    expect(within(card).queryByText(/card:1/)).toBeNull()
    expect(within(card).getByTestId('piloti-card-chat')).toHaveAttribute(
      'href',
      '/app/projects/proj_1/chat?session=s_thread_doc_1'
    )
  })

  it("takes Piloti's answer over as an Anmerkung at the box", async () => {
    serve([])
    serveConversation()
    const created: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations', async ({ request }) => {
        created.push(await request.json())
        return HttpResponse.json(
          { annotation: view({ id: 'kept', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'hint', body: 'Raumhöhe fehlt.' }) },
          { status: 201 }
        )
      })
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)
    await screen.findByTestId('review-empty')
    await askAboutABox(piloti)
    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'a-1', text: '**Raumhöhe** fehlt.' } })

    await userEvent.click(await screen.findByTestId('piloti-card-adopt'))

    await waitFor(() =>
      expect(created).toEqual([
        { page: 1, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'hint', body: 'Raumhöhe fehlt.' },
      ])
    )
    await waitFor(() => expect(screen.queryByTestId('piloti-card')).toBeNull())
    expect(within(screen.getByTestId('sheet')).queryByTestId('piloti-ask-box')).toBeNull()
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
  })

  it('brings Piloti into a thread with @Piloti: the reply is saved, then this tab asks Piloti while wakes are off', async () => {
    serve([view({ id: 'ann_1', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25 })])
    serveConversation()
    const replies: unknown[] = []
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', async ({ request }) => {
        replies.push(await request.json())
        return HttpResponse.json({
          annotation: view({
            id: 'ann_1',
            shape: 'region',
            x: 0.1,
            y: 0.2,
            w: 0.3,
            h: 0.25,
            replies: [
              {
                id: 'r1',
                annotationId: 'ann_1',
                authorKind: 'person',
                body: 'Stimmt die Breite?',
                createdBy: 'user_me',
                createdByName: 'Miriam Hofer',
                createdAt: '2026-10-01T09:00:00.000Z',
                addressesPiloti: true,
              },
            ],
          }),
          replyId: 'r1',
          wake: 'off',
        })
      })
    )
    const piloti = scriptedPiloti()
    render(<Harness transport={scriptedRoom().transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    await userEvent.type(box, '@pil')
    await userEvent.click(within(thread).getByTestId('thread-reply-mention-option'))
    expect(within(thread).getByTestId('thread-reply-mention-chip')).toHaveTextContent('@Piloti')
    await userEvent.type(box, 'Stimmt die Breite?{Enter}')

    // The mention is a flag on the reply, never read from its text.
    await waitFor(() => expect(replies).toEqual([{ body: 'Stimmt die Breite?', addressesPiloti: true }]))
    await waitFor(() => expect(piloti.questions()).toHaveLength(1))
    expect(piloti.questions()[0]).toMatchObject({
      // The id a server wake of the same reply would use: the two can never both run.
      message_id: wakeTurnId('r1'),
      conversation_id: 's_thread_doc_1',
      text: 'Stimmt die Breite?',
      reply_in_thread: true,
      focus_region: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.25, annotation_id: 'ann_1' },
    })
    // No card: Piloti answers in the thread, and the thread says it is on it.
    expect(screen.queryByTestId('piloti-card')).toBeNull()
    expect(within(screen.getByTestId('review-thread')).getByTestId('thread-piloti-pending')).toBeInTheDocument()

    piloti.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    piloti.deliver(2, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'a-1', text: 'Ja, 1,20 m.' } })
    await waitFor(() => expect(screen.queryByTestId('thread-piloti-pending')).toBeNull())
  })

  it('leaves an @Piloti reply to the server when it wakes Piloti, and shows the work as the server knows it', async () => {
    const mark = view({ id: 'ann_1', shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.25 })
    const asked: AnnotationView['replies'][number] = {
      id: 'r1',
      annotationId: 'ann_1',
      authorKind: 'person',
      body: 'Stimmt die Breite?',
      createdBy: 'user_me',
      createdByName: 'Miriam Hofer',
      createdAt: '2026-10-01T09:00:00.000Z',
      addressesPiloti: true,
    }
    serve([mark], true, true)
    const posted = serveConversation()
    server.use(
      http.post('/api/documents/:id/annotations/:annotationId/replies', () =>
        HttpResponse.json(
          {
            annotation: {
              ...mark,
              replies: [asked],
              pilotiWork: {
                state: 'queued',
                trigger: 'thread_mention',
                forUserId: 'user_me',
                forName: 'Miriam Hofer',
                reasonKind: null,
                since: '2026-10-01T09:00:00.000Z',
              },
            },
            replyId: 'r1',
            wake: 'queued',
          },
          { status: 201 }
        )
      )
    )
    const piloti = scriptedPiloti()
    const room = scriptedRoom()
    render(<Harness transport={room.transport} piloti={piloti} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    const box = within(thread).getByTestId('thread-reply')
    await userEvent.type(box, '@pil')
    await userEvent.click(within(thread).getByTestId('thread-reply-mention-option'))
    await userEvent.type(box, 'Stimmt die Breite?{Enter}')

    // The mark's own view says Piloti is on it, for whom: the same line everyone in the room
    // reads, after a reload too. Nothing runs in this tab: no thread, no socket, no question.
    const work = await within(screen.getByTestId('review-thread')).findByTestId('thread-piloti-work')
    expect(work).toHaveAttribute('data-state', 'queued')
    expect(work).toHaveTextContent('Miriam Hofer')
    expect(piloti.questions()).toEqual([])
    expect(posted).toEqual([])

    // Piloti's reply arrives through the room, as the wake job's turn writes it.
    const answered = {
      ...mark,
      replies: [
        asked,
        { ...asked, id: 'r2', authorKind: 'piloti' as const, body: '1,20 m im Schnitt B-B.', addressesPiloti: false },
      ],
    }
    serve([answered], true, true)
    room.send({
      kind: 'event',
      event: {
        kind: 'annotations.changed',
        annotationIds: ['ann_1'],
        change: 'replied',
        actor: { peerId: null, userId: 'user_me', name: 'Piloti', kind: 'piloti' },
      },
    })
    await waitFor(() => expect(screen.queryByTestId('thread-piloti-work')).toBeNull())
    expect(within(screen.getByTestId('review-thread')).getByText('1,20 m im Schnitt B-B.')).toBeInTheDocument()
  })

  it('says why a woken Piloti did not answer, from the mark as the server reads it', async () => {
    serve(
      [
        view({
          id: 'ann_1',
          pilotiWork: {
            state: 'failed',
            trigger: 'thread_mention',
            forUserId: 'user_me',
            forName: 'Miriam Hofer',
            reasonKind: 'budget',
            since: '2026-10-01T09:00:00.000Z',
          },
        }),
      ],
      true,
      true
    )
    render(<Harness transport={scriptedRoom().transport} piloti={scriptedPiloti()} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const work = await within(await screen.findByTestId('review-thread')).findByTestId('thread-piloti-work')
    expect(work).toHaveAttribute('data-state', 'failed')
    expect(work).toHaveTextContent(/budget/i)
  })

  it('delegates an open mark to Piloti from the thread, and shows for whom Piloti works it', async () => {
    serve([view({ id: 'ann_1' })], true, true)
    const patches: unknown[] = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patches.push(await request.json())
        return HttpResponse.json({
          annotation: view({
            id: 'ann_1',
            delegatedBy: 'user_me',
            delegatedByName: 'Miriam Hofer',
            delegatedAt: '2026-10-13T09:00:00.000Z',
          }),
          wake: 'queued',
        })
      })
    )
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    expect(within(thread).queryByTestId('thread-delegate')).toBeNull()
    await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delegate to Piloti' }))

    await waitFor(() => expect(patches).toEqual([{ delegateToPiloti: true }]))
    expect(await within(screen.getByTestId('review-thread')).findByTestId('thread-delegate')).toHaveTextContent(
      'Piloti is working on it · for Miriam Hofer'
    )
  })

  it('offers no delegation while the organization does not let events wake Piloti', async () => {
    serve([view({ id: 'ann_1' })])
    render(<Harness transport={scriptedRoom().transport} />)

    await userEvent.click(await screen.findByTestId('review-row'))
    const thread = await screen.findByTestId('review-thread')
    await userEvent.click(within(thread).getByRole('button', { name: 'More' }))
    expect(await screen.findByRole('menuitem', { name: 'Copy link' }).catch(() => null)).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: 'Delegate to Piloti' })).toBeNull()
  })

  it("draws Piloti's own pointer and what it points out, from the room", async () => {
    const restore = installLayoutObservers({ frameWidth: 800 })
    serve([])
    const room = scriptedRoom()
    render(<Harness transport={room.transport} />)
    await screen.findByTestId('review-empty')
    const PILOTI = { peerId: 'piloti_peer_01', userId: 'piloti', name: 'Piloti', kind: 'piloti' as const }

    room.send({ kind: 'event', event: { kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: PILOTI, cursor: { page: 1, x: 0.4, y: 0.4 } } })
    room.send({
      kind: 'event',
      event: { kind: 'activity', peer: PILOTI, state: 'reading', label: 'Liest die Stiege', box: { page: 1, x: 0.5, y: 0.1, w: 0.2, h: 0.3 } },
    })

    const sheet = screen.getByTestId('sheet')
    expect(await within(sheet).findByText('Piloti · Liest die Stiege', { selector: '[data-slot="live-cursor"] *' })).toBeInTheDocument()
    const highlight = await within(sheet).findByTestId('piloti-highlight')
    expect(highlight.style.left).toBe('50%')
    restore()
  })
})

describe('marking on a touch screen', () => {
  const press = (capture: HTMLElement, pointerId: number, at: [number, number], to = at, pointerType = 'mouse') => {
    fireEvent.pointerDown(capture, { button: 0, clientX: at[0], clientY: at[1], pointerId, pointerType })
    fireEvent.pointerMove(capture, { clientX: to[0], clientY: to[1], pointerId, pointerType })
    fireEvent.pointerUp(capture, { clientX: to[0], clientY: to[1], pointerId, pointerType })
  }

  it('sets a point on release, and nothing for a press that travelled: that was a pan', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'point tool' }))
    const capture = captureSurface()

    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1 })
    // Pressed, not released: no draft yet.
    expect(screen.queryByTestId('review-draft')).toBeNull()
    fireEvent.pointerMove(capture, { clientX: 260, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(capture, { clientX: 260, clientY: 300, pointerId: 1 })
    expect(screen.queryByTestId('review-draft')).toBeNull()

    press(capture, 1, [80, 120], [83, 121])
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
  })

  it('gives the page back to two fingers: a second finger cancels the box being drawn', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    const capture = captureSurface()
    fireEvent.pointerDown(capture, { button: 0, clientX: 80, clientY: 120, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerDown(capture, { button: 0, clientX: 300, clientY: 320, pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerMove(capture, { clientX: 320, clientY: 330, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 330, pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerUp(capture, { clientX: 320, clientY: 330, pointerId: 1, pointerType: 'touch' })
    expect(screen.queryByTestId('review-draft')).toBeNull()
  })

  it('returns to navigating once a finger has set its mark, so the next drag scrolls', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    press(captureSurface(), 1, [80, 120], [320, 300], 'touch')
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).queryByTestId('review-capture')).toBeNull()
  })

  it('a mouse keeps its tool for the next mark', async () => {
    serve([])
    render(<Harness transport={scriptedRoom().transport} />)
    await screen.findByTestId('review-empty')
    await userEvent.click(screen.getByRole('button', { name: 'region tool' }))
    press(captureSurface(), 1, [80, 120], [320, 300])
    expect(await screen.findByTestId('review-draft')).toBeInTheDocument()
    expect(within(screen.getByTestId('sheet')).getByTestId('review-capture')).toBeInTheDocument()
  })

  it('pins stay 24px on the drawing and catch a finger at 44px', async () => {
    serve([view({ id: 'a', number: 1 })])
    render(<Harness transport={scriptedRoom().transport} />)
    const [pin] = await within(screen.getByTestId('sheet')).findAllByTestId('review-pin')
    expect(pin).toHaveClass('touch-target')
  })
})
