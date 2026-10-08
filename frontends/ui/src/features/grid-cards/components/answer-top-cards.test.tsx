/**
 * The proposal shell's lifecycle accent, because "pending" is a lifecycle
 * state and not a compliance warning (§A3).
 */

import { describe, expect, it } from 'vitest'
import { render as rtlRender } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { ProposalShell } from './ProposalShell'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>,
  )

describe('ProposalShell', () => {
  it('accents a pending proposal in ink, never in the warning colour', () => {
    // Lifecycle is its own axis (§A3). Amber already means "close to a limit"
    // on a Frist callout, on a tightening change and inside a tolerance band —
    // spending it on "we are waiting for you" made an unanswered question look
    // like a compliance risk.
    const { container } = render(<ProposalShell tone="pending">Merken?</ProposalShell>)
    const card = container.querySelector('[data-slot="card"]')

    expect(card).toHaveClass('border-l-foreground/40')
    expect(card, 'warning means "close to a limit" everywhere else in the set').not.toHaveClass(
      'border-l-warning',
    )
  })

  it('still spends the verdict colours on the two states that are outcomes', () => {
    const { container: accepted } = render(<ProposalShell tone="accepted">Ja</ProposalShell>)
    expect(accepted.querySelector('[data-slot="card"]')).toHaveClass('border-l-success')

    const { container: dismissed } = render(<ProposalShell tone="dismissed">Nein</ProposalShell>)
    expect(dismissed.querySelector('[data-slot="card"]')).toHaveClass('border-l-subtle')
  })
})
