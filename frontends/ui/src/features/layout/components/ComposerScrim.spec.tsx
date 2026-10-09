import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ComposerScrim } from './ComposerScrim'

describe('ComposerScrim', () => {
  it('fades the thread out above the composer, without taking a click', () => {
    render(<ComposerScrim threadEmpty={false} />)
    const fade = screen.getByTestId('composer-fade')
    expect(fade).toHaveAttribute('aria-hidden', 'true')
    expect(fade.className).toContain('pointer-events-none')
    // Under the jump button and the status dock (`ChatArea`'s z-10).
    expect(fade.className).toContain('z-[5]')
    // Never a veil over text where the reader asked for contrast or system colours.
    expect(fade.className).toContain('contrast-more:hidden')
    expect(fade.className).toContain('forced-colors:hidden')
  })

  it('draws no fade on the empty canvas, where the composer is lifted and there is no thread', () => {
    render(<ComposerScrim threadEmpty />)
    expect(screen.queryByTestId('composer-fade')).toBeNull()
  })
})
