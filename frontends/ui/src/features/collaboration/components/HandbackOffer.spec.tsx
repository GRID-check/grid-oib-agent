import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

import { HandbackOffer } from './HandbackOffer'

const ANNA = { userId: 'u-anna', name: 'Anna Weber' }
const MARKUS = { userId: 'u-markus', name: 'Markus Hofer' }

describe('HandbackOffer — the way on, once the colleague has answered', () => {
  test('names who answered and offers exactly one action plus a dismissal', () => {
    render(<HandbackOffer people={[ANNA]} onAccept={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByText('Anna Weber replied — let Piloti carry on?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Let Piloti carry on' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  test('pluralises when several people answered', () => {
    render(<HandbackOffer people={[ANNA, MARKUS]} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(
      screen.getByText('Anna Weber, Markus Hofer replied — let Piloti carry on?'),
    ).toBeInTheDocument()
  })

  test('renders nothing with nobody to name — there is no honest offer to make', () => {
    const { container } = render(
      <HandbackOffer people={[]} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  test('the action reports the accept, and the ✕ the dismissal', async () => {
    const onAccept = vi.fn()
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(<HandbackOffer people={[ANNA]} onAccept={onAccept} onDismiss={onDismiss} />)

    await user.click(screen.getByRole('button', { name: 'Let Piloti carry on' }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('carries the answering colleague’s avatar', () => {
    render(<HandbackOffer people={[ANNA]} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getAllByTestId('person-avatar')).toHaveLength(1)
  })
})
