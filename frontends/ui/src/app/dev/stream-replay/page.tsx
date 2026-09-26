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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import {
  EMPTY_SPECTATED_TURN,
  reduceSpectatedFrame,
  type SpectatedTurnState,
} from '@/features/collaboration/lib/spectator-frames'
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
  /** The answer so far, folded by the observer's fold (see `applyFrame`). */
  turn: SpectatedTurnState
  confidence?: 'low' | 'medium' | 'high'
  phase: 'waiting' | 'prose' | 'settled' | 'cards' | 'final'
}

const EMPTY: View = { turn: EMPTY_SPECTATED_TURN, phase: 'waiting' }

/**
 * One frame folded into the view by a real fold, not a copy of one: the
 * observer's `reduceSpectatedFrame`, which applies the asker's store's
 * live-frame rules (its rule 3, held to the store by a spec case in each) and
 * needs no store to run. What it adds on top: an observer is never handed a
 * card that acts, so an interactive card would be a hole here. Both recorded
 * fixtures carry only `legal_basis` cards, so nothing is withheld. The
 * confidence chip and the phase label are read off the frame, as the fold
 * does not keep them.
 */
const applyFrame = (view: View, frame: RecordedFrame): View => {
  const turn = reduceSpectatedFrame(view.turn, {
    ...frame,
    type: 'system_response_message',
    parent_id: 'replay',
    content: { text: frame.content },
  })
  if (frame.status === 'complete') {
    return { turn, confidence: frame.answer_confidence ?? view.confidence, phase: 'final' }
  }
  const phase = frame.stream_replace
    ? 'settled'
    : frame.cards && frame.cards.length > 0
      ? 'cards'
      : view.phase === 'waiting'
        ? 'prose'
        : view.phase
  return { ...view, turn, phase }
}

const describe = (node: Node | null | undefined): string => {
  if (!node || !(node instanceof Element)) return String(node?.nodeName ?? 'text')
  const cls =
    typeof node.className === 'string' ? node.className.split(' ').slice(0, 3).join('.') : ''
  return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

export default function StreamReplayPage() {
  const params = useSearchParams()
  const name = (params.get('fixture') === 'oib2' ? 'oib2' : 'varianten') as 'varianten' | 'oib2'
  const speed = Number(params.get('speed') ?? '1') || 1
  const turn = STREAM_FRAMES[name]
  const [view, setView] = useState<View>(EMPTY)

  const probe = useMemo<ReplayProbe>(
    () => ({ phase: 'waiting', done: false, shifts: [], anchorTops: [] }),
    []
  )
  // When the replay started: shifts and anchor tops are both timed from it.
  const startRef = useRef(0)

  useEffect(() => {
    window.__replay = probe
    const start = performance.now()
    startRef.current = start
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
    // Every timer this effect starts, the settle timer the last frame starts
    // included, so an unmount mid-replay leaves none of them running.
    const timers: number[] = []
    const later = (run: () => void, ms: number) => timers.push(window.setTimeout(run, ms))
    turn.frames.forEach((frame, index) =>
      later(
        () => {
          setView((current) => applyFrame(current, frame))
          if (index === turn.frames.length - 1) later(() => (probe.done = true), 1500)
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
        t: Math.round(performance.now() - startRef.current),
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
            content={view.turn.answer}
            timestamp={new Date('2026-09-24T14:30:12')}
            isStreaming={!view.turn.done}
            cards={view.turn.cards}
            citations={view.turn.citations}
            answerConfidence={view.confidence}
            answerMeta={view.turn.answerMeta}
            routingDecision="shallow"
            messageId={`replay-${name}`}
          />
        )}
      </div>
    </main>
  )
}
