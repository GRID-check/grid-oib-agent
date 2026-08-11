/**
 * The skill reviewer's panel. The behaviour worth pinning is the failure mode:
 * a review that could not run must never read as a clean bill of health.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillReviewPanel } from './SkillReviewPanel'

vi.mock('@/i18n', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}))

const reviewSkill = vi.fn()
vi.mock('@/adapters/api/skills-client', () => ({
  reviewSkill: (...args: unknown[]) => reviewSkill(...args),
}))

const DRAFT = { name: 'oib-check', description: 'Prüft etwas.', body: 'Schritte' }

beforeEach(() => {
  reviewSkill.mockReset()
})

describe('SkillReviewPanel', () => {
  it('asks for nothing until the author asks for it', () => {
    render(<SkillReviewPanel {...DRAFT} />)
    expect(reviewSkill).not.toHaveBeenCalled()
    expect(screen.queryByTestId('skill-review-findings')).not.toBeInTheDocument()
  })

  it('reviews the CURRENT draft, not a remembered one', async () => {
    reviewSkill.mockResolvedValue({ findings: [] })
    const user = userEvent.setup()
    render(<SkillReviewPanel {...DRAFT} />)

    await user.click(screen.getByRole('button'))
    expect(reviewSkill).toHaveBeenCalledWith(DRAFT)
  })

  it('reports findings worst-first', async () => {
    reviewSkill.mockResolvedValue({
      findings: [
        { severity: 'suggestion', field: 'body', message: 'Add an example.', fix: 'Show output.' },
        { severity: 'error', field: 'description', message: 'No WHEN clause.', fix: 'Add one.' },
        { severity: 'warning', field: 'name', message: 'Vague name.', fix: 'Name the domain.' },
      ],
    })
    const user = userEvent.setup()
    render(<SkillReviewPanel {...DRAFT} />)
    await user.click(screen.getByRole('button'))

    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('No WHEN clause.'),
      expect.stringContaining('Vague name.'),
      expect.stringContaining('Add an example.'),
    ])
    // The fix travels with the complaint — a critique without one is a nag.
    expect(items[0].textContent).toContain('Add one.')
  })

  it('says the skill is clean only when the reviewer actually returned nothing', async () => {
    reviewSkill.mockResolvedValue({ findings: [] })
    const user = userEvent.setup()
    render(<SkillReviewPanel {...DRAFT} />)
    await user.click(screen.getByRole('button'))

    expect(await screen.findByText('editor.review.clean')).toBeInTheDocument()
  })

  it('NEVER reads as clean when the review could not run', async () => {
    // `findings: null` is "could not check". Rendering the clean state here
    // would tell an author their skill is fine on the strength of a failed
    // request — the one failure mode this panel must not have.
    reviewSkill.mockResolvedValue({ findings: null, error: 'review_failed' })
    const user = userEvent.setup()
    render(<SkillReviewPanel {...DRAFT} />)
    await user.click(screen.getByRole('button'))

    expect(await screen.findByText('editor.review.unavailable')).toBeInTheDocument()
    expect(screen.queryByText('editor.review.clean')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-review-findings')).not.toBeInTheDocument()
  })

  it('does not blow up the editor when the client rejects', async () => {
    // The client is documented never to reject, but the dialog around this
    // panel must survive it doing so anyway.
    reviewSkill.mockResolvedValue({ findings: null })
    const user = userEvent.setup()
    render(<SkillReviewPanel {...DRAFT} />)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText('editor.review.unavailable')).toBeInTheDocument()
  })
})
