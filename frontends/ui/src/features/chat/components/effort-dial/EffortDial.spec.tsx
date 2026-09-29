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

  it('holds the dot trail still while the thumb reveals it', async () => {
    mockOrgSettings({})
    render(<EffortDial conversationId="c1" />)

    fireEvent.click(screen.getByTestId('effort-dial-trigger'))
    fireEvent.change(await screen.findByTestId('effort-dial-slider'), { target: { value: '3' } })

    // The trail's window glides with the thumb; the dots inside glide back by the same share.
    expect(screen.getByTestId('effort-dial-trail')).toHaveAttribute('data-share', '-0.75')
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
})
