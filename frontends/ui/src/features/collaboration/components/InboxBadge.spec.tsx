import { describe, expect, test } from 'vitest'
import { render, screen } from '@/test-utils'

import { InboxBadge } from './InboxBadge'

/**
 * The badge's contract is small and entirely about edge cases: nothing at zero, a
 * capped display that never loses the true count, and the right key from the
 * `…One`/`…Many` pair (this i18n layer has no plural rules).
 *
 * Tests render without an I18nProvider, so they see the default locale (`en`).
 */
describe('InboxBadge', () => {
  test('renders nothing at all when nothing is pending (no empty circle)', () => {
    const { container } = render(<InboxBadge pending={0} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('inbox-badge')).not.toBeInTheDocument()
  })

  test('renders nothing for a negative or non-finite count', () => {
    expect(render(<InboxBadge pending={-3} />).container).toBeEmptyDOMElement()
    expect(render(<InboxBadge pending={Number.NaN} />).container).toBeEmptyDOMElement()
  })

  test('uses the singular aria key for exactly one item', () => {
    render(<InboxBadge pending={1} />)
    const badge = screen.getByTestId('inbox-badge')
    expect(badge).toHaveTextContent('1')
    expect(badge).toHaveAttribute('aria-label', '1 item needs your attention')
  })

  test('interpolates the count into the plural aria key', () => {
    render(<InboxBadge pending={4} />)
    const badge = screen.getByTestId('inbox-badge')
    expect(badge).toHaveTextContent('4')
    expect(badge).toHaveAttribute('aria-label', '4 items need your attention')
  })

  test('caps the visible number at 99+ but keeps the true count in the label', () => {
    render(<InboxBadge pending={128} />)
    const badge = screen.getByTestId('inbox-badge')
    expect(badge).toHaveTextContent('99+')
    expect(badge).not.toHaveTextContent('128')
    expect(badge).toHaveAttribute('aria-label', '128 items need your attention')
    // The exact count also stays machine-readable for the collapsed rail.
    expect(badge).toHaveAttribute('data-pending', '128')
  })

  test('accepts positioning overrides so the collapsed rail can place it', () => {
    render(<InboxBadge pending={2} className="absolute -top-1 -right-1" />)
    expect(screen.getByTestId('inbox-badge')).toHaveClass('absolute')
  })
})
