import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { OtherProjectsNotice } from './OtherProjectsNotice'

describe('OtherProjectsNotice (ADR-0093)', () => {
  it('names each other project, a closed one as closed, and says what that closes', () => {
    render(
      <OtherProjectsNotice
        projects={[
          { id: 'g', name: 'Wohnbau Graz', status: 'closed' },
          { id: 'l', name: 'Schule Linz', status: 'active' },
        ]}
      />
    )

    const notice = screen.getByTestId('other-projects-notice')
    expect(notice.textContent).toContain('Wohnbau Graz (closed)')
    expect(notice.textContent).toContain('Schule Linz')
    expect(notice.textContent).toContain('project memory')
  })

  it('renders nothing for a chat that drew on no other project', () => {
    const { container } = render(<OtherProjectsNotice projects={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
