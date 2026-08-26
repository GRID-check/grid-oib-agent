/**
 * The two blocks that compete for the top of an answer, and the one place a
 * card in this system is allowed to know what its neighbours are.
 *
 * `summary` opens the answer with a 17px H1; `verdict_header` opens it with a
 * 30px figure. Each is right on its own and together they give the reader two
 * places to start, so the charter (§A2) has `summary` drop to the Title step
 * whenever a verdict header is present. That rule is invisible from either
 * component alone — it only exists once both are on screen — which is why it
 * is tested through the dispatcher the chat actually renders.
 *
 * Also here: the proposal shell's lifecycle accent, because "pending" is a
 * lifecycle state and not a compliance warning (§A3).
 */

import { describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import type { GridCard } from '@/shared/cards/schemas'
import { GridCards } from './GridCards'
import { SummaryCard } from './SummaryCard'
import { ProposalShell } from './ProposalShell'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>,
  )

const SUMMARY = {
  type: 'summary' as const,
  title: 'Gebäudeklasse 4 – Anforderungen im Überblick',
  content: 'Für Ihr Wohngebäude mit Fluchtniveau 9,8 m gilt Gebäudeklasse 4.',
  key_points: ['Fluchtniveau 9,8 m → GK 4 (Grenze: 11 m)'],
}

const VERDICT = {
  type: 'verdict_header',
  verdict: 'Gebäudeklasse 4',
  subject: 'Einstufung des Gebäudes',
} as const

describe('SummaryCard', () => {
  it('sets its title at the Value step when it opens the answer alone', () => {
    render(<GridCards cards={[SUMMARY] as unknown as GridCard[]} projectId={null} />)

    expect(screen.getByText(SUMMARY.title)).toHaveClass('card-value')
  })

  it('demotes the title to a muted lead-in when a verdict header is also in the answer', () => {
    render(<GridCards cards={[VERDICT, SUMMARY] as unknown as GridCard[]} projectId={null} />)

    const title = screen.getByText(SUMMARY.title)
    expect(title, 'two 15px+ lines at the top of one answer is two ledes').toHaveClass('card-body')
    expect(title).toHaveClass('text-muted-foreground')
    expect(title).not.toHaveClass('card-value')
    // Demoted, never dropped: the field the model filled still renders.
    expect(title).toBeInTheDocument()
  })

  it('applies the rule even when the verdict header was placed inline and only the summary falls through', () => {
    // The chat splits an answer's cards between the ones a `[[card:N]]` marker
    // placed in the prose and the ones that fall through to the block below, so
    // this stack routinely holds a SUBSET. The question "is there a verdict
    // header in this answer" is not one a subset can answer.
    render(
      <GridCards
        cards={[VERDICT, SUMMARY] as unknown as GridCard[]}
        indices={[1]}
        projectId={null}
      />,
    )

    expect(screen.queryByText(VERDICT.verdict)).not.toBeInTheDocument()
    expect(screen.getByText(SUMMARY.title)).toHaveClass('card-body')
  })

  it('hangs the key points off the answer’s own rule, not a disclosure hairline', () => {
    // `border-border` is the hairline every disclosure panel in the set uses,
    // and it says "this is an aside". These are the answer's own emphasis.
    const { container } = render(<SummaryCard {...SUMMARY} />)

    expect(container.querySelector('ul')).toHaveClass('border-l-2', 'border-foreground/20')
  })
})

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
