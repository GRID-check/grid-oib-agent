/**
 * The viewport controls.
 *
 * These exist as a separate component precisely so they can be tested: the
 * canvas needs WebGPU and is unreachable here, but the controls are the part a
 * person touches and the part whose behaviour is easy to get subtly wrong —
 * a cut switched on at floor level shows an empty view, and a plan drawn in
 * perspective is not a plan.
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IfcViewerToolbar } from './ifc-viewer-toolbar'

function toolbar(overrides: Partial<React.ComponentProps<typeof IfcViewerToolbar>> = {}) {
  const props = {
    view: 'iso' as const,
    onViewChange: vi.fn(),
    orthographic: false,
    onOrthographicChange: vi.fn(),
    section: null,
    onSectionChange: vi.fn(),
    cutRange: { minMetres: -0.5, maxMetres: 6.25 },
    defaultCutMetres: null,
    xray: false,
    onXrayChange: vi.fn(),
    onFit: vi.fn(),
    ...overrides,
  }
  render(<IfcViewerToolbar {...props} />)
  return props
}

describe('IfcViewerToolbar', () => {
  it('offers a plan and the four elevations, not just orbit', () => {
    toolbar()

    for (const label of ['Free', 'Plan', 'North', 'South', 'East', 'West']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the current view as pressed so the reader knows where they are', () => {
    toolbar({ view: 'north' })

    expect(screen.getByRole('button', { name: 'North' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the view the reader picked', async () => {
    const props = toolbar()
    await userEvent.click(screen.getByRole('button', { name: 'Plan' }))

    expect(props.onViewChange).toHaveBeenCalledWith('top')
  })

  it('shows no cut slider until there is a cut', () => {
    toolbar()

    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('puts a new cut a metre above the storey floor, where a Grundriss is cut', async () => {
    // At the floor itself the plane slices the slab and the view comes back
    // empty, which reads as a broken model rather than a bad cut height.
    const props = toolbar({ defaultCutMetres: 4.2 })
    await userEvent.click(screen.getByRole('button', { name: 'Section' }))

    expect(props.onSectionChange).toHaveBeenCalledWith({ atMetres: 4.2, flipped: false })
  })

  it('falls back into the model rather than to zero when no storey is chosen', async () => {
    const props = toolbar({ defaultCutMetres: null, cutRange: { minMetres: 0, maxMetres: 6 } })
    await userEvent.click(screen.getByRole('button', { name: 'Section' }))

    expect(props.onSectionChange).toHaveBeenCalledWith({ atMetres: 2, flipped: false })
  })

  it('switches an existing cut off rather than moving it', async () => {
    const props = toolbar({ section: { atMetres: 2.6, flipped: false } })
    await userEvent.click(screen.getByRole('button', { name: 'Section' }))

    expect(props.onSectionChange).toHaveBeenCalledWith(null)
  })

  it('shows the cut height in metres, to the centimetre', () => {
    toolbar({ section: { atMetres: 2.6, flipped: false } })

    const slider = screen.getByRole('slider')
    expect(slider).toHaveValue('2.6')
    expect(screen.getByText('2.60 m')).toBeInTheDocument()
  })

  it('bounds the slider to the model, not to an arbitrary range', () => {
    toolbar({ section: { atMetres: 2.6, flipped: false }, cutRange: { minMetres: -0.5, maxMetres: 6.25 } })

    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('min', '-0.5')
    expect(slider).toHaveAttribute('max', '6.25')
  })

  it('flips the cut without losing its height', async () => {
    const props = toolbar({ section: { atMetres: 2.6, flipped: false } })
    await userEvent.click(screen.getByRole('button', { name: 'Looking down' }))

    expect(props.onSectionChange).toHaveBeenCalledWith({ atMetres: 2.6, flipped: true })
  })

  it('names the projection it is in, not the one it would switch to', () => {
    // A button reading "Perspective" while the view IS parallel is the classic
    // toggle-label bug, and on a drawing it decides whether the reader trusts
    // a dimension they scaled off the screen.
    const { unmount } = render(
      <IfcViewerToolbar
        view="top"
        onViewChange={vi.fn()}
        orthographic
        onOrthographicChange={vi.fn()}
        section={null}
        onSectionChange={vi.fn()}
        cutRange={null}
        defaultCutMetres={null}
        xray={false}
        onFit={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Parallel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Perspective' })).not.toBeInTheDocument()
    unmount()

    toolbar({ orthographic: false })
    expect(screen.getByRole('button', { name: 'Perspective' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('fits without touching any other state', async () => {
    const props = toolbar()
    await userEvent.click(screen.getByRole('button', { name: 'Fit to view' }))

    expect(props.onFit).toHaveBeenCalledTimes(1)
    expect(props.onViewChange).not.toHaveBeenCalled()
    expect(props.onSectionChange).not.toHaveBeenCalled()
  })

  it('hides the x-ray toggle when the page cannot honour it', () => {
    toolbar({ onXrayChange: undefined })

    expect(screen.queryByRole('button', { name: 'X-ray' })).not.toBeInTheDocument()
  })

  it('disables every control while the model is still loading', () => {
    toolbar({ disabled: true, section: { atMetres: 2.6, flipped: false } })

    for (const control of screen.getAllByRole('button')) expect(control).toBeDisabled()
    expect(screen.getByRole('slider')).toBeDisabled()
  })
})
