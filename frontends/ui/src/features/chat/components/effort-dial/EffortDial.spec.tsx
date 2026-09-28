import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

import { useEffortStore } from '../../stores/effort-store'
import { EffortDial, resetEffortDialDefaultRequest } from './EffortDial'

function mockOrgSettings(settings: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ settings: { settings } }), { status: 200 }))
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

  it('runs the dot fill up to the thumb', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    const slider = await screen.findByTestId('effort-dial-slider')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(screen.getByTestId('effort-dial-fill').style.getPropertyValue('--effort-share')).toBe('0')

    fireEvent.change(slider, { target: { value: '4' } })
    expect(screen.getByTestId('effort-dial-fill').style.getPropertyValue('--effort-share')).toBe('1')
  })

  it('does not open its help tooltip when a click opens the dial', async () => {
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? false : matches.call(this, selector)
    })
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    await screen.findByTestId('effort-dial')

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps the product default when the settings cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    render(<EffortDial conversationId="c1" />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.getByTestId('effort-dial-trigger')).toHaveTextContent('Medium')
  })
})
