import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TourCard, type TourCardProps } from './tour-card'

const LABELS = { next: 'Next', back: 'Back', done: 'Get started', close: 'Close tour', progress: '2 of 3' }

function renderCard(props: Partial<TourCardProps> = {}) {
  const handlers = { onNext: vi.fn(), onBack: vi.fn(), onClose: vi.fn() }
  render(
    <TourCard title="Start with a project" step={1} total={3} labels={LABELS} {...handlers} {...props}>
      A project holds one building.
    </TourCard>,
  )
  return handlers
}

describe('TourCard', () => {
  it('is a labelled dialog that says where the reader is', () => {
    renderCard()
    const dialog = screen.getByRole('dialog', { name: 'Start with a project' })
    expect(dialog).toHaveAccessibleDescription('A project holds one building.')
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
  })

  it('moves focus to the primary action so Enter walks the tour', () => {
    renderCard()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus()
  })

  it('wires next, back and close to their own callbacks', () => {
    const { onNext, onBack, onClose } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close tour' }))
    expect(onNext).toHaveBeenCalledOnce()
    expect(onBack).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers no Back on the first stop', () => {
    renderCard({ step: 0 })
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })

  it('finishes through onNext on the last stop, so completion is not a skip', () => {
    const { onNext, onClose } = renderCard({ step: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(onNext).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })
})
