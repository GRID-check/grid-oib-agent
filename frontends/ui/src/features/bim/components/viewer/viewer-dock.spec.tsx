import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Home } from 'lucide-react'
import { ViewerDock } from './viewer-dock'
import { ViewerIconButton } from './viewer-icon-button'

describe('ViewerDock', () => {
  it('keeps the empty space around the pills out of the pointer’s way', () => {
    // The dock spans the full width so it can centre itself. If that wrapper
    // swallowed events, the bottom sixth of the model would be undraggable —
    // a dead strip across the building with no visible cause.
    const { container } = render(
      <ViewerDock>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain('pointer-events-none')
    expect(screen.getByRole('button', { name: 'Ebenen' }).closest('.pointer-events-auto')).not.toBeNull()
  })

  it('sets the lead control apart in its own pill', () => {
    const { container } = render(
      <ViewerDock lead={<ViewerIconButton label="Ganzes Modell" icon={Home} />}>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    // Two surfaces, not one row of buttons: "get me back" and "change what I
    // see" are different jobs and the gap is what says so.
    expect(container.querySelectorAll('[data-slot="viewer-surface"]')).toHaveLength(2)
  })

  it('adds a third pill for the way out to the advanced surfaces', () => {
    const { container } = render(
      <ViewerDock
        lead={<ViewerIconButton label="Ganzes Modell" icon={Home} />}
        trail={<ViewerIconButton label="Mehr" icon={Home} />}
      >
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    expect(container.querySelectorAll('[data-slot="viewer-surface"]')).toHaveLength(3)
  })

  it('renders the section slider above the bar rather than inside it', () => {
    render(
      <ViewerDock above={<div data-testid="cut-slider" />}>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    expect(screen.getByTestId('cut-slider')).toBeInTheDocument()
  })
})
