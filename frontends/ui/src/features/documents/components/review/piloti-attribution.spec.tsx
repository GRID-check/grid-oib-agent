/**
 * Piloti on the canvas and in the Prüfansicht says whose request it works on (ADR-0105; EU AI Act
 * Art. 50): its cursor tag reads „Piloti · für Anna", or „Treppe · für Anna"
 * beside a pointer label (in the specs' English: „Piloti · for Anna"), and the
 * name is never the part that is clipped. Its marks and replies carry the same
 * line: „Piloti · für Anna" on the pin's tooltip, the list row and the thread,
 * a proposal as „Proposal by Piloti · for Anna", and a reply a wake wrote says
 * what woke it. The name is the server's (`publishAsAgent` stamps `forName`); a
 * Piloti peer without one keeps its plain tag rather than inventing a person.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { roomEventSchema, type RoomPeer } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import type { DocumentReview } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { pilotiForShort, ReviewPageLayer } from './review-page-layer'
import { ReviewPanel } from './review-panel'
import { ThreadCard } from './thread-card'
import { fixedStore } from '@/features/realtime/use-channel'

const PILOTI: RoomPeer = {
  peerId: 'piloti-conv_42',
  userId: 'user_anna',
  name: 'Piloti',
  kind: 'piloti',
  forName: 'Anna Berger',
}

const pilotiState = (overrides: Partial<RoomPeerState> = {}): RoomPeerState => ({
  peer: PILOTI,
  cursor: { page: 1, x: 0.4, y: 0.5 },
  movedAt: null,
  tool: 'select',
  viewport: null,
  draft: null,
  chat: null,
  label: null,
  selected: null,
  activity: null,
  highlight: null,
  expiresAt: Date.now() + 25_000,
  ...overrides,
})

/** The review as far as the page layer reads it: no marks, no tool in hand, one room. */
function reviewWith(peers: RoomPeerState[]): DocumentReview {
  const room: Partial<DocumentReview['room']> = {
    peers: fixedStore(peers),
    highlights: fixedStore([]),
    sendCursor: () => {},
    sendDraft: () => {},
  }
  const piloti: Partial<DocumentReview['piloti']> = { asks: [], openId: null, compose: () => 'ask_1', open: () => {} }
  const review: Partial<DocumentReview> = {
    annotations: [],
    tool: 'select',
    draft: null,
    selectedId: null,
    hoveredId: null,
    filter: 'open',
    room: room as DocumentReview['room'],
    piloti: piloti as DocumentReview['piloti'],
    select: () => {},
    setDraft: () => {},
    hover: () => {},
  }
  return review as DocumentReview
}

const cursorTag = () => {
  const cursor = document.querySelector<HTMLElement>('[data-slot="live-cursor"]')
  if (!cursor) throw new Error('no cursor on the page')
  return cursor
}

const renderLayer = (peers: RoomPeerState[]) =>
  render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <div>
        <ReviewPageLayer page={1} review={reviewWith(peers)} focused={false} />
      </div>
    </div>
  )

let restore: () => void
beforeEach(() => {
  restore = installLayoutObservers({ frameWidth: 800 })
})
afterEach(() => restore())

describe('Piloti’s cursor on the canvas', () => {
  it('reads „Piloti · for Anna" when its pointer says nothing else', () => {
    renderLayer([pilotiState()])
    const tag = cursorTag()
    expect(within(tag).getByText('Piloti')).toBeInTheDocument()
    expect(within(tag).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
    expect(tag.textContent?.replace(/\s+/g, ' ')).toMatch(/^Piloti ?· for Anna$/)
  })

  it('keeps „for Anna" beside its pointer label and what it is doing, outside the part that truncates', () => {
    renderLayer([pilotiState({ label: 'Treppe' })])
    // Its name always leads: a pointer saying „Treppe" is never taken for a colleague of that name.
    expect(within(cursorTag()).getByText('Piloti · Treppe')).toHaveClass('truncate')
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).not.toHaveClass('truncate')
  })

  it('says it while it works, too', () => {
    renderLayer([pilotiState({ activity: { state: 'reading', box: null, label: 'sieht sich Seite 2 an' } })])
    expect(within(cursorTag()).getByText('Piloti · sieht sich Seite 2 an')).toBeInTheDocument()
    expect(within(cursorTag()).getByTestId('piloti-cursor-for')).toHaveTextContent('· for Anna')
  })

  it('says which page it reads when the room only knows the box it reads', () => {
    renderLayer([pilotiState({ activity: { state: 'reading', box: { page: 2, x: 0, y: 0, w: 1, h: 1 }, label: null } })])
    expect(within(cursorTag()).getByText('Piloti · reading page 2')).toBeInTheDocument()
  })

  it('names nobody when the server could not', () => {
    const { forName: _, ...nameless } = PILOTI
    renderLayer([pilotiState({ peer: nameless })])
    expect(within(cursorTag()).getByText('Piloti')).toBeInTheDocument()
    expect(screen.queryByTestId('piloti-cursor-for')).not.toBeInTheDocument()
  })

  it('carries the name the server stamped through the room’s own parse', () => {
    const event = roomEventSchema.parse({ kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 })
    expect(event).toMatchObject({ peer: { forName: 'Anna Berger' } })
  })
})

describe('pilotiForShort', () => {
  it('takes the first name, the local part of a bare address, or nothing', () => {
    expect(pilotiForShort({ forName: 'Anna Berger' })).toBe('Anna')
    expect(pilotiForShort({ forName: '  Ben  ' })).toBe('Ben')
    expect(pilotiForShort({ forName: 'c.weber@buero.at' })).toBe('c.weber')
    expect(pilotiForShort({ forName: '   ' })).toBeNull()
    expect(pilotiForShort({})).toBeNull()
  })
})

const mark = (overrides: Partial<AnnotationView> = {}): AnnotationView => ({
  id: 'ann_4',
  documentId: 'doc_1',
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: null,
  authorKind: 'piloti',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 2,
  onCurrentFassung: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  acceptedBy: 'user_anna',
  acceptedByName: 'Anna Berger',
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

const reply = (overrides: Partial<AnnotationView['replies'][number]> = {}): AnnotationView['replies'][number] => ({
  id: 'r_1',
  annotationId: 'ann_4',
  authorKind: 'piloti',
  body: '1,20 m im Schnitt B-B.',
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-01T09:00:00.000Z',
  addressesPiloti: false,
  ...overrides,
})

/** The review as far as the list, the pins and the thread read it. */
function reviewOf(annotations: AnnotationView[]): DocumentReview {
  const review: Partial<DocumentReview> = {
    ...(reviewWith([]) as DocumentReview),
    annotations,
    listed: annotations,
    counts: { open: annotations.length, proposed: 0, closed: 0 },
    load: 'ready',
    documentId: 'doc_1',
    mine: false,
    pilotiWakes: false,
    piloti: { asks: [], dismiss: () => {}, available: false } as unknown as DocumentReview['piloti'],
    select: () => {},
    setFilter: () => {},
    setMine: () => {},
  }
  return review as DocumentReview
}

const renderThread = (annotation: AnnotationView) =>
  render(<ThreadCard review={reviewOf([annotation])} annotation={annotation} placement="right" canPickAssignee={false} />)

describe('Piloti’s marks name the person they were set for', () => {
  it('on the pin’s tooltip and for a screen reader', () => {
    const annotation = mark()
    render(
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer page={1} review={reviewOf([annotation])} focused={false} />
        </div>
      </div>
    )
    const pin = screen.getByTestId('review-pin')
    expect(pin).toHaveAttribute('title', 'Piloti · for Anna Berger')
    expect(pin.getAttribute('aria-label')).toContain('Piloti · for Anna Berger')
  })

  it('says it is a proposal on the pin, and a person’s mark has no such line', () => {
    const annotations = [
      mark({ status: 'proposed', acceptedBy: null, acceptedByName: null }),
      mark({ id: 'ann_5', number: 5, authorKind: 'person', createdBy: 'user_ben', createdByName: 'Ben Huber' }),
    ]
    render(
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer page={1} review={reviewOf(annotations)} focused={false} />
        </div>
      </div>
    )
    const [proposal, person] = screen.getAllByTestId('review-pin')
    expect(proposal).toHaveAttribute('title', 'Proposal by Piloti · for Anna Berger')
    expect(person).not.toHaveAttribute('title')
  })

  it('names nobody in the tooltip when the directory does not know them', () => {
    render(
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer page={1} review={reviewOf([mark({ createdByName: null })])} focused={false} />
        </div>
      </div>
    )
    expect(screen.getByTestId('review-pin')).toHaveAttribute('title', 'Piloti')
  })

  it('in the list row', () => {
    render(<ReviewPanel review={reviewOf([mark()])} onOpen={() => {}} />)
    expect(screen.getByTestId('review-row')).toHaveTextContent('Piloti · for Anna Berger')
  })

  it('in the thread: the finding’s byline, and a proposal’s', () => {
    const { unmount } = renderThread(mark())
    expect(screen.getByTestId('thread-byline')).toHaveTextContent('Piloti · for Anna Berger')
    unmount()
    renderThread(mark({ status: 'proposed', acceptedBy: null, acceptedByName: null }))
    expect(screen.getByTestId('thread-byline')).toHaveTextContent('Proposal by Piloti · for Anna Berger')
    expect(screen.getByText('Proposal')).toBeInTheDocument()
  })

  it('falls back to plain „Piloti" for a mark nobody can be named for', () => {
    renderThread(mark({ createdByName: null }))
    expect(screen.getByTestId('thread-byline').textContent).toBe('Piloti')
  })
})

describe('Piloti’s replies in a thread', () => {
  it('name the person they were written for, and a person’s reply keeps their own name', () => {
    renderThread(
      mark({
        replies: [
          reply(),
          reply({ id: 'r_2', authorKind: 'person', createdBy: 'user_ben', createdByName: 'Ben Huber', body: 'Danke' }),
        ],
      })
    )
    const bylines = screen.getAllByTestId('thread-byline')
    // The finding, then Piloti's reply; Ben's is no Piloti byline.
    expect(bylines.map((node) => node.textContent)).toEqual(['Piloti · for Anna Berger', 'Piloti · for Anna Berger'])
    expect(screen.getByText('Ben Huber')).toBeInTheDocument()
    expect(screen.queryByTestId('thread-woken')).toBeNull()
  })

  it('say what woke them, in a line of their own with the whole story as its tooltip', () => {
    renderThread(
      mark({
        replies: [
          reply({ id: 'r_1', wokenBy: 'thread_mention' }),
          reply({ id: 'r_2', wokenBy: 'thread_reply' }),
          reply({ id: 'r_3', wokenBy: 'assigned' }),
          reply({ id: 'r_4', wokenBy: null }),
        ],
      })
    )
    const lines = screen.getAllByTestId('thread-woken')
    expect(lines.map((node) => node.textContent)).toEqual([
      'Woken by a mention',
      'Woken by a reply',
      'Woken by the delegation',
    ])
    expect(lines[0]).toHaveAttribute('title', 'Woken by Anna Berger in annotation 4')
  })

  it('leave the name out of the tooltip when it is not known', () => {
    renderThread(mark({ replies: [reply({ createdByName: null, wokenBy: 'thread_mention' })] }))
    expect(screen.getByTestId('thread-woken')).toHaveAttribute('title', 'Woken in annotation 4')
  })
})
