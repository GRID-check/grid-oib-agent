'use client'

/**
 * `/dev/stream-replay?fixture=varianten&speed=1` — a recorded live answer,
 * replayed frame by frame at its recorded pace into the real `AgentResponse`.
 *
 * What it is for: seeing (and measuring) what a streamed answer does to the
 * page. Every layout shift is recorded with the phase it happened in and the
 * elements that moved, and the prose's first paragraph is tracked as the
 * reader's anchor. `window.__replay` holds both for a headless capture.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { citationsFromWireList } from '@/features/chat/lib/wire-citation'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'
import { sanitizeAnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { CitationSource } from '@/features/chat/types'
import { STREAM_FRAMES, type RecordedFrame } from '../_fixtures/stream-frames'

interface Shift {
  t: number
  phase: string
  value: number
  sources: { node: string; dy: number; dh: number }[]
}

interface ReplayProbe {
  phase: string
  done: boolean
  shifts: Shift[]
  anchorTops: { t: number; phase: string; top: number }[]
}

declare global {
  interface Window {
    __replay?: ReplayProbe
  }
}

interface View {
  content: string
  isStreaming: boolean
  citations?: CitationSource[]
  cards?: (GridCard | undefined)[]
  answerMeta?: AnswerMeta
  confidence?: 'low' | 'medium' | 'high'
  phase: 'waiting' | 'prose' | 'settled' | 'cards' | 'final'
}

const EMPTY: View = { content: '', isStreaming: true, phase: 'waiting' }

/**
 * One frame folded into the view. A copy of the store's fold, not the store: it
 * does not retract a gated-out masthead or live cards. Keep it in step with
 * `messages-store.ts`; the ADR-0066 shift numbers come from here.
 */
const applyFrame = (view: View, frame: RecordedFrame): View => {
  if (frame.status === 'complete') {
    const meta = sanitizeAnswerMeta(frame.answer_meta)
    return {
      content: frame.content || view.content,
      isStreaming: false,
      citations: citationsFromWireList(frame.sources) ?? view.citations,
      cards: validateGridCards(frame.cards ?? []),
      answerMeta: meta ?? undefined,
      confidence: frame.answer_confidence,
      phase: 'final',
    }
  }
  // A live frame may carry the masthead (before the prose) or the cards
  // written so far (after it), next to or instead of text.
  const meta = sanitizeAnswerMeta(frame.answer_meta) ?? view.answerMeta
  const cards = frame.cards && frame.cards.length > 0 ? validateGridCards(frame.cards) : view.cards
  if (frame.stream_replace) {
    return {
      ...view,
      content: frame.content,
      citations: citationsFromWireList(frame.sources) ?? view.citations,
      answerMeta: meta,
      cards,
      phase: 'settled',
    }
  }
  return {
    ...view,
    content: view.content + frame.content,
    answerMeta: meta,
    cards,
    phase: frame.cards && frame.cards.length > 0 ? 'cards' : view.phase === 'waiting' ? 'prose' : view.phase,
  }
}

const describe = (node: Node | null | undefined): string => {
  if (!node || !(node instanceof Element)) return String(node?.nodeName ?? 'text')
  const cls = typeof node.className === 'string' ? node.className.split(' ').slice(0, 3).join('.') : ''
  return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

export default function StreamReplayPage() {
  const params = useSearchParams()
  const name = (params.get('fixture') === 'oib2' ? 'oib2' : 'varianten') as 'varianten' | 'oib2'
  const speed = Number(params.get('speed') ?? '1') || 1
  const turn = STREAM_FRAMES[name]
  const [view, setView] = useState<View>(EMPTY)

  const probe = useMemo<ReplayProbe>(() => ({ phase: 'waiting', done: false, shifts: [], anchorTops: [] }), [])

  useEffect(() => {
    window.__replay = probe
    const start = performance.now()
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number
        sources?: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[]
      })[]) {
        probe.shifts.push({
          t: Math.round(entry.startTime - start),
          phase: probe.phase,
          value: Number(entry.value.toFixed(4)),
          sources: (entry.sources ?? []).map((s) => ({
            node: describe(s.node),
            dy: Math.round(s.currentRect.top - s.previousRect.top),
            dh: Math.round(s.currentRect.height - s.previousRect.height),
          })),
        })
      }
    })
    observer.observe({ type: 'layout-shift', buffered: false })

    const t0 = turn.frames[0]?.t ?? 0
    const timers = turn.frames.map((frame, index) =>
      window.setTimeout(
        () => {
          setView((current) => applyFrame(current, frame))
          if (index === turn.frames.length - 1) window.setTimeout(() => (probe.done = true), 1500)
        },
        ((frame.t - t0) * 1000) / speed + 500
      )
    )
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      observer.disconnect()
    }
  }, [probe, speed, turn])

  // The reader's anchor: where the first paragraph of the prose sits.
  useEffect(() => {
    probe.phase = view.phase
    const first = document.querySelector('[data-replay-answer] .markdown-content > :first-child')
    if (first) {
      probe.anchorTops.push({
        t: Math.round(performance.now()),
        phase: view.phase,
        top: Math.round(first.getBoundingClientRect().top + window.scrollY),
      })
    }
  }, [probe, view])

  return (
    <main className="bg-background min-h-screen p-6">
      <div className="text-muted-foreground mb-4 font-mono text-xs">
        /dev/stream-replay?fixture={name} · phase: {view.phase} · {turn.frames.length} frames
      </div>
      <div data-replay-answer className="mx-auto w-full max-w-[760px]">
        {view.phase !== 'waiting' && (
          <AgentResponse
            content={view.content}
            timestamp={new Date('2026-09-24T14:30:12')}
            isStreaming={view.isStreaming}
            cards={view.cards}
            citations={view.citations}
            answerConfidence={view.confidence}
            answerMeta={view.answerMeta}
            routingDecision="shallow"
            messageId={`replay-${name}`}
          />
        )}
      </div>
    </main>
  )
}
