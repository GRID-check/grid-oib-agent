/**
 * ChoiceCard. Pinned: the cards are one radio group — each card a radio named
 * by its label, the chosen one checked — so the arrow keys and a screen reader
 * treat them as the single choice they are; a click chooses.
 */

import { fireEvent, render, screen } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ChoiceCard, ChoiceCards } from './choice-card'

describe('ChoiceCards', () => {
  it('is one radio group, and a click chooses', () => {
    const onValueChange = vi.fn()
    render(
      <ChoiceCards value="a" onValueChange={onValueChange} aria-label="Kind">
        <ChoiceCard value="a" label="First" hint="The first one" />
        <ChoiceCard value="b" label="Second" hint="The second one" />
      </ChoiceCards>
    )
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /First/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Second/ })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('radio', { name: /Second/ }))
    expect(onValueChange).toHaveBeenCalledWith('b')
  })

  it('a disabled group chooses nothing', () => {
    const onValueChange = vi.fn()
    render(
      <ChoiceCards value="a" onValueChange={onValueChange} disabled aria-label="Kind">
        <ChoiceCard value="a" label="First" hint="One" />
        <ChoiceCard value="b" label="Second" hint="Two" />
      </ChoiceCards>
    )
    fireEvent.click(screen.getByRole('radio', { name: /Second/ }))
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
