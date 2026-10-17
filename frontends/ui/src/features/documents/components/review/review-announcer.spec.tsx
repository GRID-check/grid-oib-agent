/**
 * The review's one live region: what the others did to the marks, gathered
 * and said as one line a few seconds later, and Piloti's answer to a question
 * this reader asked. Never this reader's own changes, from this tab or another.
 */

import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranslations } from '@/i18n'
import type { AnnotationView } from '@/lib/annotations/types'
import type { CanvasAsk } from '../../hooks/use-canvas-ask'
import type { DocumentReview } from '../../hooks/use-document-review'
import { ANNOUNCE_AFTER_MS, announcementOf, ReviewAnnouncer } from './review-announcer'

type Changed = Parameters<Parameters<DocumentReview['room']['onAnnotationsChanged']>[0]>[0]

const ANNA = { peerId: 'peer_anna', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }
const PILOTI = { peerId: null, userId: 'user_me', name: 'Piloti', kind: 'piloti' as const }

function reviewWith(annotations: Array<Pick<AnnotationView, 'id' | 'number'>>, asks: Array<Pick<CanvasAsk, 'id' | 'status'>> = []) {
  const listeners = new Set<(event: Changed) => void>()
  const review = {
    room: {
      peerId: 'peer_me',
      self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' as const },
      onAnnotationsChanged: (listener: (event: Changed) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    annotations,
    piloti: { asks },
  } as unknown as Pick<DocumentReview, 'room' | 'annotations' | 'piloti'>
  const hint = (event: Omit<Changed, 'kind'>) => act(() => listeners.forEach((listener) => listener({ kind: 'annotations.changed', ...event })))
  return { review, hint }
}

describe('announcementOf', () => {
  it("gathers each one's changes into one sentence: Piloti's proposals by count, a person's marks by number", () => {
    const { result } = renderHook(() => useTranslations('files'))
    const numbers: Record<string, number> = { a7: 7 }
    const line = announcementOf(
      [
        { kind: 'change', actor: { ...PILOTI }, change: 'created', ids: ['p1', 'p2'] },
        { kind: 'change', actor: { ...ANNA }, change: 'created', ids: ['a7'] },
        { kind: 'change', actor: { ...PILOTI }, change: 'created', ids: ['p3'] },
        { kind: 'answered' },
      ],
      (id) => numbers[id] ?? null,
      result.current
    )
    expect(line).toBe('Piloti set 3 proposals. Anna Berger: new annotation 7. Piloti answered')
  })
})

describe('ReviewAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("says what the others did a moment later, in one line, and never this reader's own", () => {
    const { review, hint } = reviewWith([{ id: 'a7', number: 7 }])
    render(<ReviewAnnouncer review={review} />)
    const region = screen.getByTestId('review-announcer')
    expect(region).toHaveAttribute('aria-live', 'polite')

    hint({ annotationIds: ['a7'], change: 'created', actor: { ...ANNA } })
    // This tab, and this reader in another tab: nothing to tell them.
    hint({ annotationIds: ['a7'], change: 'updated', actor: { ...ANNA, peerId: 'peer_me', userId: 'user_me', name: 'Miriam Hofer' } })
    hint({ annotationIds: ['a7'], change: 'replied', actor: { peerId: 'peer_other_tab', userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
    hint({ annotationIds: ['p1', 'p2', 'p3'], change: 'created', actor: { ...PILOTI } })
    expect(region).toHaveTextContent('')

    act(() => vi.advanceTimersByTime(ANNOUNCE_AFTER_MS))
    expect(region).toHaveTextContent('Anna Berger: new annotation 7. Piloti set 3 proposals')
  })

  it('says the same line again when the same thing happens again', () => {
    const { review, hint } = reviewWith([{ id: 'a7', number: 7 }])
    render(<ReviewAnnouncer review={review} />)
    const region = screen.getByTestId('review-announcer')
    const said: string[] = []
    for (let round = 0; round < 3; round += 1) {
      hint({ annotationIds: ['a7'], change: 'replied', actor: { ...ANNA } })
      act(() => vi.advanceTimersByTime(ANNOUNCE_AFTER_MS))
      said.push(region.textContent ?? '')
    }
    // Each round changes the region's text, so each is announced; it reads the same.
    expect(said[0]).not.toBe(said[1])
    expect(said[1]).not.toBe(said[2])
    for (const line of said) expect(line.replace('\u200b', '')).toBe('Anna Berger: new reply on annotation 7')
  })

  it('says Piloti answered when a question this reader asked leaves thinking', () => {
    const { review } = reviewWith([], [{ id: 'ask_1', status: 'thinking' }])
    const view = render(<ReviewAnnouncer review={review} />)
    view.rerender(<ReviewAnnouncer review={reviewWith([], [{ id: 'ask_1', status: 'answered' }]).review} />)
    act(() => vi.advanceTimersByTime(ANNOUNCE_AFTER_MS))
    expect(screen.getByTestId('review-announcer')).toHaveTextContent('Piloti answered')
  })
})
