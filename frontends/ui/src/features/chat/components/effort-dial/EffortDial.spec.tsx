import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

import { useEffortStore } from '../../stores/effort-store'
import { EffortDial, resetEffortDialDefaultRequest } from './EffortDial'

function mockOrgSettings(settings: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ settings: { settings } }), { status: 200 })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('EffortDial', () => {
  beforeEach(() => {
    resetEffortDialDefaultRequest()
    useEffortStore.setState({ orgDefault: 'medium', draft: null, byConversation: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("shows the organization's default on a chat that never chose", async () => {
    mockOrgSettings({ chatReasoningEffort: 'low' })
    render(<EffortDial conversationId="c1" />)

    await waitFor(() => expect(screen.getByTestId('effort-dial-trigger')).toHaveTextContent('Low'))
  })

  it('moves this chat, and only this chat, along the dial', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    const slider = await screen.findByTestId('effort-dial-slider')
    fireEvent.change(slider, { target: { value: '4' } })

    expect(screen.getByTestId('effort-dial-level')).toHaveTextContent('Maximum')
    expect(slider).toHaveAttribute('aria-valuetext', 'Maximum')
    expect(useEffortStore.getState().levelForSend('c1')).toBe('xhigh')
    expect(useEffortStore.getState().levelForSend('c2')).toBe('medium')
  })

  it('marks every stop and moves the thumb to the chosen one', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    const slider = await screen.findByTestId('effort-dial-slider')
    expect(screen.getAllByTestId('effort-dial-stop')).toHaveLength(5)

    fireEvent.change(slider, { target: { value: '0' } })
    expect(screen.getByTestId('effort-dial-thumb')).toHaveAttribute('data-share', '0')

    fireEvent.change(slider, { target: { value: '3' } })
    expect(screen.getByTestId('effort-dial-thumb')).toHaveAttribute('data-share', '0.75')
  })

  it('carries the fill with the thumb', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    fireEvent.change(await screen.findByTestId('effort-dial-slider'), { target: { value: '3' } })

    expect(screen.getByTestId('effort-dial-fill')).toHaveAttribute('data-share', '0.75')
  })

  it('warns while Maximum is chosen, and only then', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    const slider = await screen.findByTestId('effort-dial-slider')
    expect(screen.queryByTestId('effort-dial-maximum-warning')).not.toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '4' } })
    expect(screen.getByTestId('effort-dial-maximum-warning')).toHaveTextContent(
      'Rarely smarter than High'
    )
    expect(screen.getByTestId('effort-dial-trigger')).toHaveClass('text-warning')

    fireEvent.change(slider, { target: { value: '3' } })
    // It folds away rather than vanishing, so it leaves the DOM after its exit.
    await waitFor(() =>
      expect(screen.queryByTestId('effort-dial-maximum-warning')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('effort-dial-trigger')).not.toHaveClass('text-warning')
  })

  it('does not open its help tooltip when a click opens the dial', async () => {
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string
    ) {
      return selector === ':focus-visible' ? false : matches.call(this, selector)
    })
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    await screen.findByTestId('effort-dial')

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps the product default when the settings cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    render(<EffortDial conversationId="c1" />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.getByTestId('effort-dial-trigger')).toHaveTextContent('Medium')
  })

  it('keeps the chip one width: every level is laid out, only the current one shows', async () => {
    mockOrgSettings({ chatReasoningEffort: 'low' })
    render(<EffortDial conversationId="c1" />)

    await waitFor(() =>
      expect(screen.getByTestId('effort-dial-trigger')).toHaveAccessibleName(expect.stringContaining('Low'))
    )
    const labels = Array.from(screen.getByTestId('effort-dial-label').children)
    expect(labels).toHaveLength(5)
    const shown = labels.filter((label) => label.getAttribute('aria-hidden') !== 'true')
    expect(shown.map((label) => label.textContent)).toEqual(['Low'])
  })

  it('stays mounted when hidden: invisible, out of the tab order, silent', () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" hidden />)

    const trigger = screen.getByTestId('effort-dial-trigger')
    expect(trigger).toHaveClass('invisible')
    expect(trigger).toHaveAttribute('aria-hidden', 'true')
    expect(trigger).toHaveAttribute('tabindex', '-1')
  })

  it('closes its popover when it hides', async () => {
    mockOrgSettings({})
    const { rerender } = render(<EffortDial conversationId="c1" />)
    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    expect(await screen.findByTestId('effort-dial')).toBeInTheDocument()

    rerender(<EffortDial conversationId="c1" hidden />)
    await waitFor(() => expect(screen.queryByTestId('effort-dial')).not.toBeInTheDocument())
  })

  it('hands the focus to the field it is given when it hides while focused', async () => {
    mockOrgSettings({})
    const field = { current: null as HTMLTextAreaElement | null }
    const Row = ({ hidden }: { hidden: boolean }) => (
      <>
        <textarea aria-label="field" ref={(node) => void (field.current = node)} />
        <EffortDial conversationId="c1" hidden={hidden} focusOnHide={field} />
      </>
    )
    const { rerender } = render(<Row hidden={false} />)
    const trigger = screen.getByTestId('effort-dial-trigger')
    trigger.focus()
    expect(trigger).toHaveFocus()

    rerender(<Row hidden />)
    expect(screen.getByRole('textbox', { name: 'field' })).toHaveFocus()
  })

  it('hands the focus on from the open slider too, and it stays handed on', async () => {
    mockOrgSettings({})
    const field = { current: null as HTMLTextAreaElement | null }
    const Row = ({ hidden }: { hidden: boolean }) => (
      <>
        <textarea aria-label="field" ref={(node) => void (field.current = node)} />
        <EffortDial conversationId="c1" hidden={hidden} focusOnHide={field} />
      </>
    )
    const { rerender } = render(<Row hidden={false} />)
    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    const slider = await screen.findByRole('slider')
    slider.focus()

    rerender(<Row hidden />)
    await waitFor(() => expect(screen.queryByTestId('effort-dial')).not.toBeInTheDocument())
    // Radix's close returns focus to its trigger; that trigger is hidden now.
    expect(screen.getByRole('textbox', { name: 'field' })).toHaveFocus()
  })

  it('lets go of the focus when it hides with nowhere given to send it', () => {
    mockOrgSettings({})
    const { rerender } = render(<EffortDial conversationId="c1" />)
    const trigger = screen.getByTestId('effort-dial-trigger')
    trigger.focus()

    rerender(<EffortDial conversationId="c1" hidden />)
    expect(trigger).not.toHaveFocus()
  })
})
