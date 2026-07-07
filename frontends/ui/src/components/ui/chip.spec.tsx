import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Chip, ChipCount } from './chip'

describe('Chip', () => {
  it('renders children and the muted default variant', () => {
    render(<Chip>Grid noted</Chip>)
    const chip = screen.getByText('Grid noted')
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveClass('bg-muted')
  })

  it('applies the requested variant and interactive affordances', () => {
    render(
      <Chip variant="info" interactive>
        Interactive
      </Chip>
    )
    const chip = screen.getByText('Interactive')
    expect(chip).toHaveClass('bg-info-subtle')
    expect(chip).toHaveClass('cursor-pointer')
  })

  it('renders as its child element when asChild is set (composable trigger)', () => {
    render(
      <Chip asChild interactive>
        <button type="button">Open</button>
      </Chip>
    )
    const button = screen.getByRole('button', { name: 'Open' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveClass('cursor-pointer')
  })

  it('ChipCount renders the count', () => {
    render(<ChipCount>3</ChipCount>)
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})
