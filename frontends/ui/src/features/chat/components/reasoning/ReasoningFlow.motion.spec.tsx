/**
 * How a live Herleitung streams in, at the render level (`reasoning-motion.tsx`).
 *
 * The entrances are CSS keyed on a class that is set ONCE, when a node or a
 * connector first arrives in a live graph. A CSS animation replays only when
 * its element is created again or its class comes back, so the properties
 * worth pinning are: the class lands on what is new, it never moves on to what
 * was already there, a remount of a known id does not earn it again, and a
 * settled graph or a reader who asked for less motion gets none of it.
 */

import { render } from '@/test-utils'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MotionEdgePath, ReasoningFlow } from './ReasoningFlow'
import { ReasoningMotionContext, type ReasoningMotion } from './reasoning-motion'
import type { ThinkingStep } from '../../types'

/** `n` retrieval rounds, each concluding something and returning one file. */
const spineSteps = (n: number): ThinkingStep[] => {
  const steps: ThinkingStep[] = []
  for (let i = 0; i < n; i++) {
    steps.push({
      id: `r${i}`,
      userMessageId: 'u1',
      category: 'agents',
      functionName: `status:retrieval:${i}`,
      displayName: `status:retrieval:${i}`,
      content: JSON.stringify({
        kind: 'status',
        channel: 'live',
        slot: `retrieval:${i}`,
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: `Suchbegriff ${i}` },
        tools: ['knowledge_search'],
        reason: `Folgerung ${i}.`,
      }),
      timestamp: new Date(),
      isComplete: true,
    })
    steps.push({
      id: `t${i}`,
      userMessageId: 'u1',
      category: 'tools',
      functionName: 'knowledge_search',
      displayName: 'knowledge_search',
      content: '',
      timestamp: new Date(),
      isComplete: true,
      traceLanes: [
        {
          key: 'baurecht_oib',
          label: 'OIB-Richtlinie',
          hitCount: 1,
          signal: 'law',
          sources: [{ name: `Quelle_${i}.pdf`, round: i }],
        },
      ],
    })
  }
  return steps
}

/**
 * The root element of checkpoint `index`. The suite renders each node through
 * its component with no React Flow wrapper (`vitest.setup.ts`), so a round is
 * found by the fold control it stretches over.
 */
const roundRoot = (index: number) =>
  document.querySelectorAll('[data-testid="reasoning-round-toggle"]')[index]?.parentElement ?? null
const entering = () =>
  Array.from(document.querySelectorAll('.reasoning-enter, .reasoning-enter-fade'))
const enteringCards = () =>
  Array.from(document.querySelectorAll('[data-source-card]')).filter((el) =>
    el.parentElement?.className.includes('animate-in')
  )

describe('a live Herleitung streams in', () => {
  test('a new node enters, and a node already on screen does not enter again', () => {
    const { rerender } = render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" live />)
    const firstRound = roundRoot(0)
    expect(firstRound).not.toBeNull()
    expect(firstRound!.className).toContain('reasoning-enter')
    expect(roundRoot(2)).toBeNull()

    rerender(<ReasoningFlow steps={spineSteps(3)} userQuestion="Frage?" live />)
    // The round that arrived enters…
    expect(roundRoot(2)!.className).toContain('reasoning-enter')
    // …and the one that was on screen is the SAME element with the same class:
    // neither a remount nor a class toggle, the only two ways a CSS animation
    // can play a second time.
    expect(roundRoot(0)).toBe(firstRound)
    expect(firstRound!.className).toContain('reasoning-enter')
  })

  test('the live graph grows to its new height; a settled one does not animate it', () => {
    const { rerender } = render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" live />)
    const pane = document.querySelector('[data-testid="reasoning-flow"]')!
    expect(pane.className).toContain('reasoning-flow-grow')
    rerender(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" answerConfidence="high" />)
    expect(pane.className).not.toContain('reasoning-flow-grow')
  })
})

describe('a settled Herleitung is simply there', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('a finished turn, opened later, renders with no entrance at all', () => {
    render(<ReasoningFlow steps={spineSteps(3)} userQuestion="Frage?" answerConfidence="high" />)
    expect(roundRoot(0)).not.toBeNull()
    expect(entering()).toHaveLength(0)
    expect(enteringCards()).toHaveLength(0)
    expect(document.querySelector('.reasoning-flow-grow')).toBeNull()
  })

  test('a reader who asked for less motion gets none, even on a live turn', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
    render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" live />)
    expect(roundRoot(0)).not.toBeNull()
    expect(entering()).toHaveLength(0)
    expect(enteringCards()).toHaveLength(0)
    expect(document.querySelector('.reasoning-flow-grow')).toBeNull()
  })
})

describe('a connector draws itself in exactly once', () => {
  const liveMotion = (): ReasoningMotion => ({ enter: true, entered: new Set(), drawn: new Set() })

  const Edge = ({ motion, id, path }: { motion: ReasoningMotion; id: string; path: string }) => (
    <ReactFlowProvider>
      <ReasoningMotionContext.Provider value={motion}>
        <svg>
          <MotionEdgePath
            id={id}
            path={path}
            markerEnd={undefined}
            style={undefined}
            flow={false}
          />
        </svg>
      </ReasoningMotionContext.Provider>
    </ReactFlowProvider>
  )
  const stroke = () => document.querySelector('path.react-flow__edge-path')!

  test('a new connector draws over a unit path length, and keeps drawing as it is reshaped', () => {
    const motion = liveMotion()
    const { rerender } = render(<Edge motion={motion} id="a->b" path="M0 0 L0 40" />)
    const path = stroke()
    expect(path.getAttribute('class')).toContain('reasoning-edge-draw')
    expect(path.getAttribute('pathLength')).toBe('1')

    // The layout pass reshapes it mid-draw: same element, same class, so the
    // draw neither restarts nor stops.
    rerender(<Edge motion={motion} id="a->b" path="M0 0 L0 80" />)
    expect(stroke()).toBe(path)
    expect(path.getAttribute('class')).toContain('reasoning-edge-draw')
  })

  test('a connector React Flow drops and brings back does not draw a second time', () => {
    const motion = liveMotion()
    const first = render(<Edge motion={motion} id="a->b" path="M0 0 L0 40" />)
    first.unmount()
    render(<Edge motion={motion} id="a->b" path="M0 0 L0 40" />)
    expect(stroke().getAttribute('class')).not.toContain('reasoning-edge-draw')
    expect(stroke().getAttribute('pathLength')).toBeNull()
  })

  test('a settled graph draws nothing', () => {
    render(<Edge motion={{ ...liveMotion(), enter: false }} id="a->b" path="M0 0 L0 40" />)
    expect(stroke().getAttribute('class')).not.toContain('reasoning-edge-draw')
  })
})
