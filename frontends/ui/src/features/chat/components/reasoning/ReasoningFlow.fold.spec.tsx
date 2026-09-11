/**
 * Folding a checkpoint layer, at the render level (ledger 19).
 *
 * `ReasoningFlow.spec.ts` covers the pure builder — which node exists, which
 * edge lands where. This covers the half the builder cannot see: that the fold
 * is a real `<button>` a keyboard reaches, that it reports its state, and that
 * pressing it actually takes the fan out of the graph and puts it back.
 *
 * React Flow is configured `nodesFocusable={false}` / `disableKeyboardA11y`
 * here, so a node is reachable ONLY through a real button inside it. That is
 * the property this file exists to keep — a fold implemented as an `onClick`
 * on the card div would pass every structural test in the sibling spec and be
 * unreachable without a mouse.
 */

import { fireEvent, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { ReasoningFlow } from './ReasoningFlow'
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

const toggles = () => screen.queryAllByTestId('reasoning-round-toggle')
const cards = () => document.querySelectorAll('[data-source-card]').length

describe('the fold control', () => {
  test('is a button, named, and reports its state', () => {
    render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" answerConfidence="high" />)
    const controls = toggles()
    expect(controls).toHaveLength(2)
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON')
      // A name of its own: the card's body is a conclusion, not a control name.
      expect(control.getAttribute('aria-label')?.trim()).toBeTruthy()
      expect(control.getAttribute('aria-expanded')).toBe('true')
    }
  })

  test('a click folds the layer to its count and a second click brings it back', async () => {
    const user = userEvent.setup()
    render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" answerConfidence="high" />)
    expect(cards()).toBe(2)

    await user.click(toggles()[0]!)
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(cards()).toBe(1)
    // The count stands in for the fan — and says nothing about the query.
    // (The suite's default locale is English; the German wording is asserted
    // against the real dictionary in `ReasoningFlow.spec.ts`.)
    expect(screen.getByText('1 file')).toBeTruthy()
    expect(screen.queryByText(/Suchbegriff/)).toBeNull()

    await user.click(toggles()[0]!)
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(cards()).toBe(2)
  })

  test('the keyboard operates it — Enter on a focused control', () => {
    render(<ReasoningFlow steps={spineSteps(2)} userQuestion="Frage?" answerConfidence="high" />)
    const control = toggles()[0]!
    ;(control as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(control)
    // A native button turns Enter into a click; asserting the click path here
    // keeps the test about the element being a button rather than about the
    // DOM implementation's key handling.
    fireEvent.click(control)
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
  })

  test('three rounds arrive with the older layers already folded', () => {
    render(<ReasoningFlow steps={spineSteps(3)} userQuestion="Frage?" answerConfidence="high" />)
    expect(toggles().map((c) => c.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'true',
    ])
    // Only the newest layer's file is on screen.
    expect(cards()).toBe(1)
  })

  test('a layer the reader opened stays open', async () => {
    const user = userEvent.setup()
    render(<ReasoningFlow steps={spineSteps(3)} userQuestion="Frage?" answerConfidence="high" />)
    await user.click(toggles()[0]!)
    expect(toggles().map((c) => c.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'true'])
    expect(cards()).toBe(2)
  })

  test('one retrieval round is not a spine and has no fold control at all', () => {
    render(<ReasoningFlow steps={spineSteps(1)} userQuestion="Frage?" answerConfidence="high" />)
    expect(toggles()).toHaveLength(0)
  })
})
