import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { OtherProjectsNotice } from './OtherProjectsNotice'

describe('OtherProjectsNotice (ADR-0093)', () => {
  it('names each running other project and says what that closes; a closed one closes nothing and is not named', () => {
    render(
      <OtherProjectsNotice
        projects={[
          { id: 'g', name: 'Wohnbau Graz', status: 'closed' },
          { id: 'l', name: 'Schule Linz', status: 'active' },
        ]}
      />
    )

    const notice = screen.getByTestId('other-projects-notice')
    expect(notice.textContent).not.toContain('Wohnbau Graz')
    expect(notice.textContent).toContain('Schule Linz')
    expect(notice.textContent).toContain('project memory')
  })

  it('renders nothing for a chat that drew on no other project, or only on closed ones', () => {
    const { container } = render(<OtherProjectsNotice projects={[]} />)
    expect(container).toBeEmptyDOMElement()
    const closedOnly = render(<OtherProjectsNotice projects={[{ id: 'g', name: 'Wohnbau Graz', status: 'closed' }]} />)
    expect(closedOnly.container).toBeEmptyDOMElement()
  })
})
