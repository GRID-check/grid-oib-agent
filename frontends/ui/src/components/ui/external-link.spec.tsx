import { render, screen } from '@/test-utils'
import { describe, expect, test } from 'vitest'
import { ExternalLink } from './external-link'

describe('ExternalLink', () => {
  test('opens in a new tab without an opener or a referrer', () => {
    render(
      <ExternalLink href="https://piloti.at/e-mail-eingang/" newTabLabel="opens in a new tab">
        How it works
      </ExternalLink>
    )

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://piloti.at/e-mail-eingang/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('says in words that it opens a new tab, and hides the icon', () => {
    const { container } = render(
      <ExternalLink href="https://piloti.at/" newTabLabel="opens in a new tab">
        How it works
      </ExternalLink>
    )

    expect(screen.getByRole('link', { name: 'How it works (opens in a new tab)' })).toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
