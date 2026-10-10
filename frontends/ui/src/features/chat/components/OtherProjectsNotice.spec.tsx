import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'
import { OtherProjectsNotice } from './OtherProjectsNotice'

describe('OtherProjectsNotice (ADR-0094)', () => {
  it('is one small chip, which names every project and says what that closes when opened', async () => {
    render(
      <OtherProjectsNotice
        projects={[
          { id: 'g', name: 'Wohnbau Graz' },
          { id: 'l', name: 'Schule Linz' },
        ]}
      />
    )

    const chip = screen.getByRole('button', { name: 'This chat draws on other projects: Wohnbau Graz and Schule Linz.' })
    expect(chip.textContent).toBe('2 other projects')
    expect(screen.queryByText(/project memory/)).not.toBeInTheDocument()

    await userEvent.click(chip)

    expect(await screen.findByText('This chat draws on other projects: Wohnbau Graz and Schule Linz.')).toBeVisible()
    expect(screen.getByText(/project memory/)).toBeVisible()
  })

  it('says so for a project that is gone, which still narrows the chat', () => {
    render(<OtherProjectsNotice projects={[{ id: 'x', name: null }]} />)

    expect(screen.getByRole('button', { name: /a project that no longer exists/ }).textContent).toBe('One other project')
  })

  it('renders nothing when nothing restricts the chat', () => {
    const { container } = render(<OtherProjectsNotice projects={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
