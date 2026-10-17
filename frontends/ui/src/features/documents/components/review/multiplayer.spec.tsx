/**
 * The room on the sheet, the way a design tool has it: a colleague's cursor
 * chat keeps their name above the words; a pointer that rests goes quiet; the
 * mark a colleague has open is ringed in their colour with their name; a box
 * being dragged out says whose it is; „/" opens a bubble at the reader's own
 * pointer that types live into the room and clears itself.
 */

import { useState } from 'react'
import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { RoomPeer } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import type { DocumentReview } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { LiveCursor } from '@/components/ui/live-cursor'
import { CURSOR_CHAT_LINGER_MS, CursorChat, placeChat } from './cursor-chat'
import { peerSide, walkPosition } from './document-review'
import {
  CURSOR_IDLE_MS,
  draftTagPlace,
  PILOTI_REST_MS,
  useRestedFor,
  peerSelections,
  pilotiResting,
  placeCard,
  ReviewPageLayer,
  selectionTagged,
} from './review-page-layer'
import { tabCounts } from './review-panel'
import { fixedStore } from '@/features/realtime/use-channel'

const ANNA: RoomPeer = { peerId: 'tab-anna', userId: 'user_anna', name: 'Anna Berger', kind: 'person' }
const JAKOB: RoomPeer = { peerId: 'tab-jakob', userId: 'user_jakob', name: 'Jakob Huber', kind: 'person' }

const person = (peer: RoomPeer, overrides: Partial<RoomPeerState> = {}): RoomPeerState => ({
  peer,
  cursor: { page: 1, x: 0.4, y: 0.5 },
  movedAt: Date.now(),
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

const MARK = {
  id: 'ann_1',
  documentId: 'doc_1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.3,
  y: 0.3,
  w: null,
  h: null,
  status: 'open',
  authorKind: 'person',
  createdBy: 'user_me',
  onCurrentFassung: true,
  kind: 'defect',
} as AnnotationView

function reviewWith(peers: RoomPeerState[], annotations: AnnotationView[] = []): DocumentReview {
  const room: Partial<DocumentReview['room']> = {
    peers: fixedStore(peers),
    highlights: fixedStore([]),
    self: { peerId: 'tab-me', userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } as DocumentReview['room']['self'],
    sendCursor: () => {},
    sendDraft: () => {},
  }
  const piloti: Partial<DocumentReview['piloti']> = { asks: [], openId: null, compose: () => 'ask_1', open: () => {} }
  const review: Partial<DocumentReview> = {
    annotations,
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

const renderLayer = (peers: RoomPeerState[], annotations: AnnotationView[] = [], focused = true) =>
  render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <div>
        <ReviewPageLayer page={1} review={reviewWith(peers, annotations)} focused={focused} />
      </div>
    </div>
  )

let restore: () => void
beforeEach(() => {
  restore = installLayoutObservers({ frameWidth: 800 })
})
afterEach(() => {
  restore()
  vi.useRealTimers()
})

describe('a colleague’s pointer', () => {
  it('keeps their name above their cursor chat, so the room knows who said it', () => {
    renderLayer([person(ANNA, { chat: 'Hier fehlt die Kote' })])
    const bubble = document.querySelector<HTMLElement>('[data-slot="live-cursor-chat"]')
    expect(bubble).not.toBeNull()
    expect(within(bubble as HTMLElement).getByText('Anna Berger')).toBeInTheDocument()
    expect(within(bubble as HTMLElement).getByText('Hier fehlt die Kote')).toBeInTheDocument()
  })

  it('goes quiet when it has rested a while, and its tag folds down to a dot with their initial', () => {
    renderLayer([person(ANNA, { movedAt: Date.now() - CURSOR_IDLE_MS - 1 }), person(JAKOB)])
    const cursors = document.querySelectorAll<HTMLElement>('[data-slot="live-cursor"]')
    expect([...cursors].map((cursor) => cursor.dataset.idle ?? null)).toEqual(['true', null])
    const dots = document.querySelectorAll<HTMLElement>('[data-slot="live-cursor-initial"]')
    expect([...dots].map((dot) => dot.textContent)).toEqual(['A'])
  })

  it("parks Piloti's pointer once the answer is in and it has stopped moving, never while it works", () => {
    const rested = { activity: null, movedAt: 1_000 }
    const later = 1_000 + PILOTI_REST_MS + 1
    expect(pilotiResting(rested, later, false)).toBe(true)
    expect(pilotiResting(rested, later, true)).toBe(false)
    expect(pilotiResting(rested, 1_000 + PILOTI_REST_MS - 1, false)).toBe(false)
    expect(pilotiResting({ ...rested, activity: { state: 'reading', label: null, box: null } }, later, false)).toBe(false)
  })

  it('says whose box is being dragged out', () => {
    renderLayer([person(ANNA, { draft: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })])
    expect(within(screen.getByTestId('review-peer-draft')).getByText('Anna')).toBeInTheDocument()
  })

  it('is the arrow alone in the preview: no name, no words, no tag on a box or a mark over the drawing', () => {
    renderLayer(
      [
        person(ANNA, { chat: 'Hier fehlt die Kote', selected: 'ann_1' }),
        person(JAKOB, { draft: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
      ],
      [MARK],
      false
    )
    expect(document.querySelectorAll('[data-slot="live-cursor"]')).toHaveLength(2)
    expect(screen.queryByText('Anna Berger')).toBeNull()
    expect(screen.queryByText('Hier fehlt die Kote')).toBeNull()
    expect(within(screen.getByTestId('review-peer-draft')).queryByText('Jakob')).toBeNull()
    expect(screen.getByTestId('review-peer-selection')).toBeInTheDocument()
    expect(screen.queryByTestId('review-peer-selection-tag')).toBeNull()
  })
})

describe('the marks the others have open', () => {
  it('rings the mark in their colour and names them, one face per person, never the reader’s own tabs', () => {
    renderLayer(
      [
        person(ANNA, { selected: 'ann_1' }),
        person({ ...ANNA, peerId: 'tab-anna-2' }, { selected: 'ann_1' }),
        person(JAKOB, { selected: 'ann_1' }),
        person({ peerId: 'tab-me-2', userId: 'user_me', name: 'Miriam Hofer', kind: 'person' }, { selected: 'ann_1' }),
      ],
      [MARK]
    )
    expect(screen.getByTestId('review-peer-selection')).toBeInTheDocument()
    expect(screen.getByTestId('review-peer-selection-tag')).toHaveTextContent('Anna +1')
  })

  it('groups by mark and leaves Piloti out: it says what it does with its own pointer', () => {
    const piloti: RoomPeer = { peerId: 'piloti-c', userId: 'user_anna', name: 'Piloti', kind: 'piloti' }
    const selections = peerSelections(
      [person(ANNA, { selected: 'ann_1' }), person(JAKOB, { selected: 'ann_2' }), person(piloti, { selected: 'ann_1' })],
      'user_me'
    )
    expect([...selections.entries()].map(([mark, states]) => [mark, states.map((state) => state.peer.userId)])).toEqual([
      ['ann_1', ['user_anna']],
      ['ann_2', ['user_jakob']],
    ])
  })
})

describe('where a card goes', () => {
  const page = { width: 800, height: 600 }

  it('hangs beside the mark on the side a whole card fits, measured in pixels', () => {
    expect(placeCard({ x: 0.2, y: 0.3, w: 0.1 }, page).placement).toBe('right')
    expect(placeCard({ x: 0.7, y: 0.3, w: 0.1 }, page)).toEqual({ x: 0.7, y: 0.3, placement: 'left' })
  })

  it('goes under a mark that leaves no room on either side, its left edge kept on the page', () => {
    // A corridor across the sheet: 5% on either side, which a share said was room enough.
    expect(placeCard({ x: 0.05, y: 0.3, w: 0.9, h: 0.1 }, page)).toEqual({ x: 0.05, y: 0.4, placement: 'below' })
    // On a narrow page the card starts where it still ends on the page.
    const narrow = placeCard({ x: 0.6, y: 0.2, w: 0.1, h: 0.1 }, { width: 400, height: 600 })
    expect(narrow.placement).toBe('below')
    expect(narrow.x * 400 + 320).toBeLessThanOrEqual(400)
  })
})

describe('whose name a selection tag still says', () => {
  const region = { page: 1, x: 0.3, y: 0.3, w: 0.2, h: 0.1 }
  const page = { width: 800, height: 600 }

  it('leaves out a colleague whose own pointer, with its own tag, is beside the mark', () => {
    const near = person(ANNA, { selected: 'ann_1', cursor: { page: 1, x: 0.52, y: 0.32 } })
    const far = person(JAKOB, { selected: 'ann_1', cursor: { page: 1, x: 0.9, y: 0.9 } })
    expect(selectionTagged([near, far], region, page).map((state) => state.peer.userId)).toEqual(['user_jakob'])
  })

  it('names everyone while the page is not measured, and a pointer on another page is not beside it', () => {
    const near = person(ANNA, { selected: 'ann_1', cursor: { page: 1, x: 0.35, y: 0.35 } })
    const elsewhere = person(JAKOB, { selected: 'ann_1', cursor: { page: 2, x: 0.35, y: 0.35 } })
    expect(selectionTagged([near, elsewhere], region, { width: 0, height: 0 })).toHaveLength(2)
    expect(selectionTagged([near, elsewhere], region, page).map((state) => state.peer.userId)).toEqual(['user_jakob'])
  })
})

describe('who is out of view', () => {
  it('says where a colleague is from where their point is laid out, not from page numbers', () => {
    const view = { top: 100, bottom: 800 }
    // Page 2 starts in view: a pointer high on it is on screen, no chip.
    expect(peerSide({ page: 2, y: 0.1 }, 1, { top: 700, height: 1000 }, view)).toBe('here')
    expect(peerSide({ page: 2, y: 0.5 }, 1, { top: 700, height: 1000 }, view)).toBe('below')
    expect(peerSide({ page: 1, y: 0.05 }, 1, { top: -400, height: 1000 }, view)).toBe('above')
  })

  it('falls back to the page numbers for a page that is not laid out', () => {
    expect(peerSide({ page: 3, y: 0.5 }, 1, null, null)).toBe('below')
    expect(peerSide({ page: 1, y: 0.5 }, 2, null, null)).toBe('above')
    expect(peerSide({ page: 2, y: 0.5 }, 2, null, null)).toBe('here')
  })
})

describe('the list counts', () => {
  const marks = [
    { status: 'open', assigneeUserId: null, createdBy: 'user_me' },
    { status: 'proposed', assigneeUserId: null, createdBy: 'user_anna' },
    { status: 'open', assigneeUserId: 'user_me', createdBy: 'user_anna' },
    { status: 'resolved', assigneeUserId: null, createdBy: 'user_anna' },
  ] as const

  it('counts what „Mine" leaves, so a tab never promises more than the list shows', () => {
    expect(tabCounts(marks, { on: false, me: 'user_me' })).toEqual({ open: 3, closed: 1 })
    expect(tabCounts(marks, { on: true, me: 'user_me' })).toEqual({ open: 2, closed: 0 })
  })
})

describe('walking the proposals', () => {
  it("says where a proposal stands among those on this Fassung, and nothing for anything else", () => {
    const marks = [
      { id: 'a', status: 'open', onCurrentFassung: true },
      { id: 'p1', status: 'proposed', onCurrentFassung: true },
      { id: 'old', status: 'proposed', onCurrentFassung: false },
      { id: 'p2', status: 'proposed', onCurrentFassung: true },
    ] as const
    expect(walkPosition(marks, 'p2')).toEqual({ index: 2, total: 2 })
    expect(walkPosition(marks, 'a')).toBeNull()
  })
})

describe('cursor chat', () => {
  const canvas = { left: 0, top: 50, width: 1000, height: 800 }
  const size = { width: 240, height: 64 }

  it('opens centred above the toolbars when there is no pointer to open at, inside the canvas', () => {
    expect(placeChat(null, canvas, size, 72)).toEqual({ left: 380, top: 50 + 800 - 72 - 64 })
  })

  it('opens beside the pointer, and never past the canvas edge', () => {
    expect(placeChat({ x: 100, y: 200 }, canvas, size, 72)).toEqual({ left: 114, top: 216 })
    // The toolbar's own corner: the bubble would have opened under the window's edge.
    expect(placeChat({ x: 40, y: 840 }, canvas, size, 72)).toEqual({ left: 54, top: 50 + 800 - 64 - 8 })
    expect(placeChat({ x: 990, y: 100 }, canvas, size, 72).left).toBe(1000 - 240 - 8)
  })

  it('takes the keys without scrolling the review to the field', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<CursorChat userId="user_me" from={null} onChat={() => {}} onClose={() => {}} />)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    focus.mockRestore()
  })

  it('types live into the room, and Enter lets the line linger before it clears', () => {
    vi.useFakeTimers()
    const said: Array<string | null> = []
    const onClose = vi.fn()
    render(<CursorChat userId="user_me" from={{ x: 100, y: 100 }} onChat={(text) => said.push(text)} onClose={onClose} />)
    const field = screen.getByTestId('cursor-chat-input')

    fireEvent.change(field, { target: { value: 'H' } })
    fireEvent.change(field, { target: { value: 'Hier' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(said).toEqual(['H', 'Hier'])
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => void vi.advanceTimersByTime(CURSOR_CHAT_LINGER_MS))
    expect(said).toEqual(['H', 'Hier', null])
  })

  it('takes the line away at once on Esc, and keeps Esc from closing anything else', () => {
    const said: Array<string | null> = []
    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    try {
      render(<CursorChat userId="user_me" from={null} onChat={(text) => said.push(text)} onClose={() => {}} />)
      const field = screen.getByTestId('cursor-chat-input')
      fireEvent.change(field, { target: { value: 'Hier' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(said).toEqual(['Hier', null])
      expect(outside).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', outside)
    }
  })
})

describe("a colleague's box being drawn", () => {
  const page = { width: 390, height: 280 }
  it('carries their name over its top-right corner while it is wider than the name', () => {
    expect(draftTagPlace({ x: 0.2, y: 0.3, w: 0.4 }, 'Jakob', page)).toBe('above')
    expect(draftTagPlace({ x: 0.2, y: 0.01, w: 0.4 }, 'Jakob', page)).toBe('inside')
  })

  it('puts the name beside a box narrower than it, so it never lies over what is left of it (a pin)', () => {
    // 0.05 of a phone's 390px page is 20px: „Jakob" is wider.
    expect(draftTagPlace({ x: 0.5, y: 0.3, w: 0.05 }, 'Jakob', page)).toBe('beside-right')
    // At the page's right edge there is no room beside it: it goes to the left.
    expect(draftTagPlace({ x: 0.9, y: 0.3, w: 0.05 }, 'Jakob', page)).toBe('beside-left')
  })
})

describe('a pointer at rest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes idle on a timer of its own: one render when it rests, not one a second', () => {
    vi.useFakeTimers()
    let renders = 0
    const movedAt = Date.now()
    const { result } = renderHook(() => {
      renders += 1
      return useRestedFor(movedAt, CURSOR_IDLE_MS)
    })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(CURSOR_IDLE_MS + 30_000))
    expect(result.current).toBe(true)
    expect(renders).toBe(2)
  })
})

describe('the cursor chat and the reader on the keyboard', () => {
  function WithChat() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          say
        </button>
        {open && <CursorChat userId="user_me" from={null} onChat={() => {}} onClose={() => setOpen(false)} />}
      </>
    )
  }

  it('gives the focus back to what had it once the bubble goes', async () => {
    render(<WithChat />)
    const trigger = screen.getByRole('button', { name: 'say' })
    trigger.focus()
    fireEvent.click(trigger)
    const field = screen.getByTestId('cursor-chat-input')
    expect(field).toHaveFocus()

    fireEvent.keyDown(field, { key: 'Escape' })
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(screen.queryByTestId('cursor-chat')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('writes in solid white on the ink, the hierarchy in size and weight (translucent white fails 4.5:1)', () => {
    render(
      <>
        <CursorChat userId="user_me" from={null} onChat={() => {}} onClose={() => {}} />
        <LiveCursor color="oklch(0.52 0.16 176)" label="Anna Berger" chat="Hier fehlt die Kote" />
      </>
    )
    const translucent = /(text-white|placeholder:text-white)\/\d+|opacity-\d+/
    for (const node of screen.getByTestId('cursor-chat').querySelectorAll('*')) expect(node.getAttribute('class') ?? '').not.toMatch(translucent)
    const bubble = document.querySelector('[data-slot="live-cursor-chat"]') as HTMLElement
    for (const node of bubble.querySelectorAll('*')) expect(node.getAttribute('class') ?? '').not.toMatch(translucent)
  })
})

describe('a pin in the file preview', () => {
  it('says nothing of a card it does not open there, even for the mark the review last had open', () => {
    render(
      <div style={{ position: 'relative', width: 800, height: 600 }}>
        <div>
          <ReviewPageLayer page={1} review={{ ...reviewWith([], [MARK]), selectedId: MARK.id }} focused={false} />
        </div>
      </div>
    )
    expect(screen.getByTestId('review-pin')).not.toHaveAttribute('aria-expanded')
  })
})
