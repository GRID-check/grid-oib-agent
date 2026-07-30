import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CountPill } from './count-pill'

describe('CountPill', () => {
  it('is muted by default — a quiet companion to whatever it counts', () => {
    render(<CountPill>5 Dokumente</CountPill>)
    const pill = screen.getByText('5 Dokumente')
    expect(pill).toHaveAttribute('data-slot', 'count-pill')
    expect(pill).toHaveClass('bg-muted')
    expect(pill).toHaveClass('text-muted-foreground')
    expect(pill).toHaveClass('tabular-nums')
  })

  it('takes the ink treatment when the count is itself the signal', () => {
    render(<CountPill tone="attention">7</CountPill>)
    const pill = screen.getByText('7')
    expect(pill).toHaveClass('bg-primary')
    expect(pill).toHaveClass('text-primary-foreground')
    // Same shape either way — the tone changes colour, never padding.
    expect(pill).toHaveClass('rounded-full')
    expect(pill).toHaveClass('px-2')
  })

  it('lets a caller position it without redefining it', () => {
    render(<CountPill className="absolute -top-1">2</CountPill>)
    expect(screen.getByText('2')).toHaveClass('absolute')
  })
})
