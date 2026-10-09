import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ComposerScrim } from './ComposerScrim'

describe('ComposerScrim', () => {
  it('draws only the floor scrim behind the composer, without taking a click', () => {
    render(<ComposerScrim />)
    const floor = screen.getByTestId('composer-floor-scrim')
    expect(floor).toHaveAttribute('aria-hidden', 'true')
    expect(floor.className).toContain('pointer-events-none')
  })

  it('draws no band above the composer: it cut the answer card flat and left the thread showing beside the input', () => {
    const { container } = render(<ComposerScrim />)
    expect(container.children).toHaveLength(1)
    expect(screen.queryByTestId('composer-fade')).toBeNull()
  })
})
