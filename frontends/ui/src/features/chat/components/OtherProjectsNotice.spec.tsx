import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { OtherProjectsNotice } from './OtherProjectsNotice'

describe('OtherProjectsNotice (ADR-0085)', () => {
  it('names every project it is given and says what that closes: the list is the server’s, not filtered here', () => {
    render(
      <OtherProjectsNotice
        projects={[
          { id: 'g', name: 'Wohnbau Graz' },
          { id: 'l', name: 'Schule Linz' },
        ]}
      />
    )

    const notice = screen.getByTestId('other-projects-notice')
    expect(notice.textContent).toContain('Wohnbau Graz and Schule Linz')
    expect(notice.textContent).toContain('project memory')
  })

  it('says so for a project that is gone, which still narrows the chat', () => {
    render(<OtherProjectsNotice projects={[{ id: 'x', name: null }]} />)

    expect(screen.getByTestId('other-projects-notice').textContent).toContain('a project that no longer exists')
  })

  it('renders nothing when nothing restricts the chat', () => {
    const { container } = render(<OtherProjectsNotice projects={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
