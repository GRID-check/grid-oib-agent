'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnnotationRequestError,
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
} from '@/lib/annotations/client'
import {
  compareAnnotations,
  isLive,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationView,
  type UpdateAnnotationRequest,
} from '@/lib/annotations/types'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import { useCanvasAsk, type UseCanvasAskOptions } from './use-canvas-ask'
import { useDocumentRoom, type RoomTransport } from './use-document-room'

/** `ask`: drag a box and ask Piloti about it (P). */
export type ReviewTool = 'select' | 'point' | 'region' | 'ask'
export type ReviewFilter = 'open' | 'closed'

/** A burst of hints naming more marks than this reads the list once instead of each mark on its own. */
export const HINT_READ_ONE_BY_ONE = 8

/** How long a mark must stay open before opening it counts as reading its news: J/K past it does not. */
export const MARK_NEWS_SETTLE_MS = 400
/** How soon the same mark's news is read again in this tab: once a minute is enough for a busy thread. */
const MARK_NEWS_AGAIN_MS = 60_000
/** When this tab last read each mark's news (`documentId:annotationId`). Per tab, per session. */
const markNewsReadAt = new Map<string, number>()

/**
 * Opening a mark is reading its news: the reader's informational inbox items
 * anchored on it (a reply, the mark closed, Piloti's finished work) are read,
 * through the inbox's own client (`POST /api/inbox/read` with the anchor), so
 * the inbox stops calling news the reader has just seen. Requests stay open:
 * seeing a mark is not answering it. Best effort; a miss costs an unread row.
 */
export function readMarkNews(documentId: string, annotationId: string, client: InboxClient = inboxClient): void {
  const key = `${documentId}:${annotationId}`
  const last = markNewsReadAt.get(key)
  if (last !== undefined && Date.now() - last < MARK_NEWS_AGAIN_MS) return
  markNewsReadAt.set(key, Date.now())
  void client.markMarkRead({ documentId, annotationId }).catch(() => markNewsReadAt.delete(key))
}

/** For the specs: forget what this tab has read. */
export function forgetMarkNewsReads(): void {
  markNewsReadAt.clear()
}

/** A place picked on a page and not yet saved: a point, or a region dragged out. */
export interface ReviewDraft {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
}

/**
 * Everything a review of one document holds, shared by the inline preview and
 * the focused review, so a mark selected in one is selected in the other and
 * a tab is in the room once: the Anmerkungen, the room, the tool in hand, the
 * draft, the selection, the filter, and the questions asked of Piloti on the
 * canvas (`use-canvas-ask.ts`). Piloti itself is in the room, as a peer.
 *
 * The list is the server's: every write replaces its row with what the API
 * answered, and a change somebody else made (a room hint) re-reads the list,
 * so a resolver's name, a number or a colleague's reply always comes from the
 * server rather than from a guess here.
 */
export function useDocumentReview(
  documentId: string,
  {
    enabled,
    transport,
    piloti: pilotiOptions,
  }: {
    enabled: boolean
    transport?: RoomTransport
    /** Asking Piloti on the canvas; absent (or without a project) it is not offered. */
    piloti?: Omit<UseCanvasAskOptions, 'documentId' | 'enabled'>
  }
) {
  const room = useDocumentRoom(documentId, { enabled, transport })
  const canvas = useCanvasAsk({ ...pilotiOptions, documentId, enabled })
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [annotations, setAnnotations] = useState<AnnotationView[]>([])
  const [canAnnotate, setCanAnnotate] = useState(false)
  /** The organization lets events wake Piloti: an @Piloti reply is the server's to answer, and a mark can be delegated. */
  const [pilotiWakes, setPilotiWakes] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [tool, setToolState] = useState<ReviewTool>('select')
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Which mark this reader has open, for the room: Piloti resolves „diese Anmerkung“ by it.
  const { sendSelection } = room
  useEffect(() => sendSelection(selectedId), [selectedId, sendSelection])
  // A mark that stays open has been read, and so has its news in the inbox.
  useEffect(() => {
    if (!enabled || !selectedId) return
    const timer = setTimeout(() => readMarkNews(documentId, selectedId), MARK_NEWS_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [enabled, documentId, selectedId])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('open')
  /** Only what is on this reader's plate: assigned to them, or set by them. */
  const [mine, setMine] = useState(false)
  const [notice, setNotice] = useState<'conflict' | null>(null)

  /**
   * Which reads may still land. A read of one mark lands only if it is the
   * latest asked for that mark and no list read was asked since; a drop counts
   * as newer than any read in flight. The document that asked must still be
   * the one shown: the pane is not keyed by document, so a read of A that
   * answers after B opened must not draw A's mark on B.
   */
  const reads = useRef({ documentId, list: 0, mark: new Map<string, number>() })
  reads.current.documentId = documentId
  const bumpMark = useCallback((annotationId: string) => {
    const next = (reads.current.mark.get(annotationId) ?? 0) + 1
    reads.current.mark.set(annotationId, next)
    return next
  }, [])

  const fetchList = useCallback(async () => {
    const ticket = ++reads.current.list
    const result = await listAnnotations(documentId)
    if (reads.current.documentId !== documentId || reads.current.list !== ticket) return result.annotations
    setAnnotations(result.annotations)
    setCanAnnotate(result.canAnnotate)
    setPilotiWakes(result.pilotiWakes)
    setLoad('ready')
    return result.annotations
  }, [documentId])

  useEffect(() => {
    if (!enabled) return
    setLoad('loading')
    setDraft(null)
    setSelectedId(null)
    fetchList().catch(() => setLoad('error'))
  }, [enabled, fetchList, attempt])

  const replace = useCallback((next: AnnotationView) => {
    setAnnotations((current) =>
      [...current.filter((annotation) => annotation.id !== next.id), next].sort(compareAnnotations)
    )
  }, [])
  const drop = useCallback(
    (annotationId: string) => {
      // Gone is newer than any read of it still on its way.
      bumpMark(annotationId)
      setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId))
      setSelectedId((current) => (current === annotationId ? null : current))
    },
    [bumpMark]
  )

  /**
   * Somebody else changed the Anmerkungen: read again what the hint names,
   * each mark on its own (`GET …/annotations/{id}`), not the whole list. A
   * mark that is not there any more for this reader leaves the list. Several
   * hints in a burst (a batch of replies) are one round of reads; a burst that
   * names more marks than {@link HINT_READ_ONE_BY_ONE} reads the list once.
   * Subscribed on the room's stable callbacks, never on `room`.
   */
  const { onAnnotationsChanged, peerId } = room
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let named = new Set<string>()
    // Cleared with the subscription: an answer for the document left behind lands nowhere.
    let live = true
    const readNamed = () => {
      timer = null
      const ids = [...named]
      named = new Set()
      if (ids.length > HINT_READ_ONE_BY_ONE) {
        void fetchList().catch(() => {})
        return
      }
      for (const id of ids) {
        const ticket = bumpMark(id)
        const list = reads.current.list
        const current = () => live && reads.current.mark.get(id) === ticket && reads.current.list === list
        getAnnotation(documentId, id)
          .then((fresh) => {
            if (current()) replace(fresh)
          })
          .catch((error: unknown) => {
            if (current() && error instanceof AnnotationRequestError && error.status === 404) drop(id)
          })
      }
    }
    const unsubscribe = onAnnotationsChanged((event) => {
      if (event.actor.peerId && event.actor.peerId === peerId) return
      for (const id of event.annotationIds) named.add(id)
      if (timer) clearTimeout(timer)
      timer = setTimeout(readNamed, 120)
    })
    return () => {
      live = false
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, onAnnotationsChanged, peerId, fetchList, documentId, replace, drop, bumpMark])

  // A hint is a nudge, and a dropped one must cost seconds, not a stale list: the
  // list is read again when the room comes back after a drop, and when the tab
  // comes back into view (a laptop woken from sleep heard nothing meanwhile).
  const { status: roomStatus } = room
  const wasLive = useRef(roomStatus === 'live')
  const everLive = useRef(roomStatus === 'live')
  useEffect(() => {
    const live = roomStatus === 'live'
    // Back after a drop, not the first connect: the first read is the mount's own.
    const back = live && !wasLive.current && everLive.current
    wasLive.current = live
    everLive.current ||= live
    if (enabled && back) void fetchList().catch(() => {})
  }, [enabled, roomStatus, fetchList])
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchList().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, fetchList])

  /** A write a colleague beat: say so, and show what they did. */
  const guard = useCallback(
    async <T,>(act: () => Promise<T>): Promise<T> => {
      try {
        return await act()
      } catch (error) {
        if (error instanceof AnnotationRequestError && error.status === 409) {
          setNotice('conflict')
          void fetchList().catch(() => {})
        }
        throw error
      }
    },
    [fetchList]
  )

  const write = useMemo(() => ({ peerId: room.peerId }), [room.peerId])

  // One card beside the pages at a time: a mark's thread, the draft, or a
  // question to Piloti. Opening one puts the others away.
  const closeAskCard = canvas.open
  const select = useCallback(
    (annotationId: string | null) => {
      if (annotationId) closeAskCard(null)
      setSelectedId(annotationId)
    },
    [closeAskCard]
  )
  const placeDraft = useCallback(
    (next: ReviewDraft | null) => {
      if (next) closeAskCard(null)
      setDraft(next)
    },
    [closeAskCard]
  )
  const piloti = useMemo(
    () => ({
      ...canvas,
      compose: (...args: Parameters<typeof canvas.compose>) => {
        setDraft(null)
        setSelectedId(null)
        setToolState('select')
        return canvas.compose(...args)
      },
      ask: (input: Parameters<typeof canvas.ask>[0]) => {
        if (input.region && !input.replyInThread) {
          setDraft(null)
          setSelectedId(null)
        }
        return canvas.ask(input)
      },
      open: (id: string | null) => {
        if (id) {
          setDraft(null)
          setSelectedId(null)
        }
        canvas.open(id)
      },
    }),
    [canvas]
  )

  const setTool = useCallback((next: ReviewTool) => {
    setToolState(next)
    if (next !== 'select') setSelectedId(null)
  }, [])

  /** Set a mark at the draft, or at `place` (an answer of Piloti's taken over at its box). */
  const create = useCallback(
    async (
      content: { kind: AnnotationKind; body: string; assigneeUserId?: string | null; dueOn?: string | null },
      place: ReviewDraft | null = draft
    ) => {
      if (!place) return null
      const created = await guard(() => createAnnotation(documentId, { ...place, ...content }, write))
      replace(created)
      setDraft(null)
      setToolState('select')
      setSelectedId(created.id)
      setFilter('open')
      return created
    },
    [documentId, draft, guard, replace, write]
  )

  const update = useCallback(
    async (annotationId: string, input: UpdateAnnotationRequest) => {
      const updated = await guard(() => updateAnnotation(documentId, annotationId, input, write))
      replace(updated)
      return updated
    },
    [documentId, guard, replace, write]
  )

  /**
   * Answer in a thread. `addressesPiloti` is the composer's @Piloti chip; the
   * answer says whether the server wakes Piloti for it (`wake`), and the
   * reply's id, which a tab that asks Piloti itself turns into the turn id.
   */
  const reply = useCallback(
    async (annotationId: string, body: string, options: { addressesPiloti?: boolean } = {}) => {
      const result = await guard(() =>
        replyToAnnotation(
          documentId,
          annotationId,
          { body, ...(options.addressesPiloti ? { addressesPiloti: true } : {}) },
          write
        )
      )
      replace(result.annotation)
      return result
    },
    [documentId, guard, replace, write]
  )

  const remove = useCallback(
    async (annotationId: string) => {
      await guard(() => deleteAnnotation(documentId, annotationId, write))
      drop(annotationId)
    },
    [documentId, guard, write, drop]
  )

  const counts = useMemo(
    () => ({
      open: annotations.filter((annotation) => annotation.status === 'open').length,
      proposed: annotations.filter((annotation) => annotation.status === 'proposed').length,
      closed: annotations.filter((annotation) => !isLive(annotation)).length,
    }),
    [annotations]
  )

  const me = room.self?.userId ?? null
  const listed = useMemo(
    () =>
      annotations.filter(
        (annotation) =>
          (filter === 'open' ? isLive(annotation) : !isLive(annotation)) &&
          (!mine || (me !== null && (annotation.assigneeUserId === me || annotation.createdBy === me)))
      ),
    [annotations, filter, mine, me]
  )

  /**
   * Step to the next or previous mark, in the order the list shows them: what
   * the filter and „Mine" leave, Piloti's proposals first, as their group
   * leads the list. Only marks on this Fassung, which are on the sheet. From
   * nothing selected, J starts at the first and K at the last.
   */
  const step = useCallback(
    (direction: 1 | -1, scope: 'live' | 'proposed' = 'live') => {
      const shown = scope === 'proposed' ? annotations.filter((annotation) => annotation.status === 'proposed') : listed
      const walk = [
        ...shown.filter((annotation) => annotation.status === 'proposed'),
        ...shown.filter((annotation) => annotation.status !== 'proposed'),
      ].filter((annotation) => annotation.onCurrentFassung)
      if (walk.length === 0) return null
      const index = walk.findIndex((annotation) => annotation.id === selectedId)
      const next =
        index === -1
          ? walk[direction === 1 ? 0 : walk.length - 1]
          : walk[(index + direction + walk.length) % walk.length]
      if (!next) return null
      setSelectedId(next.id)
      return next
    },
    [annotations, listed, selectedId]
  )

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const dismissNotice = useCallback(() => setNotice(null), [])

  // One object while nothing in it changed: a host that re-renders for its own
  // reasons hands the same review on, and what is memoised under it stays put.
  return useMemo(
    () => ({
      documentId,
      room,
      piloti,
      load,
      retry,
      annotations,
      listed,
      counts,
      canAnnotate,
      pilotiWakes,
      tool,
      setTool,
      draft,
      setDraft: placeDraft,
      selectedId,
      select,
      hoveredId,
      hover: setHoveredId,
      filter,
      setFilter,
      mine,
      setMine,
      notice,
      dismissNotice,
      create,
      update,
      reply,
      remove,
      step,
    }),
    [
      documentId,
      room,
      piloti,
      load,
      retry,
      annotations,
      listed,
      counts,
      canAnnotate,
      pilotiWakes,
      tool,
      setTool,
      draft,
      placeDraft,
      selectedId,
      select,
      hoveredId,
      filter,
      mine,
      notice,
      dismissNotice,
      create,
      update,
      reply,
      remove,
      step,
    ]
  )
}

export type DocumentReview = ReturnType<typeof useDocumentReview>
