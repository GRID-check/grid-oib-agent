import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { ViewerSlider } from './viewer-slider'

function slider(overrides: Partial<Parameters<typeof ViewerSlider>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <ViewerSlider
      label="Schnitthöhe"
      min={-3}
      max={12}
      value={2.6}
      display="2,60 m"
      onChange={onChange}
      {...overrides}
    />
  )
  return { onChange }
}

describe('ViewerSlider', () => {
  it('is reachable by its visible label', () => {
    slider()
    expect(screen.getByRole('slider', { name: 'Schnitthöhe' })).toBeInTheDocument()
  })

  it('reports the model’s own extent as its range, not an arbitrary one', () => {
    slider()
    const input = screen.getByRole('slider')
    expect(input).toHaveAttribute('min', '-3')
    expect(input).toHaveAttribute('max', '12')
  })

  it('hands back a number, so the caller never parses a string', () => {
    const { onChange } = slider()
    fireEvent.change(screen.getByRole('slider'), { target: { value: '4.25' } })
    expect(onChange).toHaveBeenCalledWith(4.25)
  })

  it('shows the value with its unit, so it can be quoted', () => {
    slider()
    expect(screen.getByText('2,60 m')).toBeInTheDocument()
  })

  it('renders an action that belongs to the cut', () => {
    slider({ action: <button type="button">Nach oben</button> })
    expect(screen.getByRole('button', { name: 'Nach oben' })).toBeInTheDocument()
  })
})
