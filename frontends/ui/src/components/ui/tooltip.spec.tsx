import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/** jsdom counts every focus as keyboard focus; the pointer case has to be stated. */
function focusVisible(visible: boolean) {
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? visible : matches.call(this, selector)
  })
}

function renderTooltip() {
  render(
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button">Hilfe</button>
      </TooltipTrigger>
      <TooltipContent>Erklärung</TooltipContent>
    </Tooltip>
  )
  return screen.getByRole('button', { name: 'Hilfe' })
}

describe('Tooltip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stays closed when focus arrives without a keyboard, as when a popover opens on a click', () => {
    focusVisible(false)
    fireEvent.focus(renderTooltip())

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens on keyboard focus', () => {
    focusVisible(true)
    fireEvent.focus(renderTooltip())

    expect(screen.getByRole('tooltip')).toHaveTextContent('Erklärung')
  })

  it('still runs the caller’s own focus handler', () => {
    focusVisible(false)
    const onFocus = vi.fn()
    render(
      <Tooltip>
        <TooltipTrigger onFocus={onFocus}>Hilfe</TooltipTrigger>
        <TooltipContent>Erklärung</TooltipContent>
      </Tooltip>
    )
    fireEvent.focus(screen.getByRole('button', { name: 'Hilfe' }))

    expect(onFocus).toHaveBeenCalledOnce()
  })
})
