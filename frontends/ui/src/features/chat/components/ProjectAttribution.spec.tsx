/**
 * The attribution line exists because the shelf stopped being an answer.
 *
 * So the tests that matter are the two suppressions — a project chat, where
 * naming the room the reader is standing in is noise, and a shelf that is not a
 * project's, where a project name would be a claim about provenance that
 * nothing carried.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectAttribution } from './ProjectAttribution'

const props = {
  projectId: 'p1',
  projectName: 'Seestadt Nord',
  shelf: 'project' as const,
  show: true,
}

it('names the project a passage came from', () => {
  render(<ProjectAttribution {...props} />)
  expect(screen.getByText('Project Seestadt Nord')).toBeInTheDocument()
})

describe('where it stays silent', () => {
  it('in a project chat — the reader is already standing in it', () => {
    const { container } = render(<ProjectAttribution {...props} show={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['base', 'archiv', 'session'] as const)(
    'on the %s shelf, which belongs to no project',
    (shelf) => {
      const { container } = render(<ProjectAttribution {...props} shelf={shelf} />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it('when the wire named no project — a name is never derived', () => {
    const { container } = render(
      <ProjectAttribution {...props} projectId={undefined} projectName={undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

it('names the Steckbrief first on a register row, and the project second', () => {
  render(<ProjectAttribution {...props} shelf="register" />)
  expect(screen.getByText('Project profile · Seestadt Nord')).toBeInTheDocument()
})

describe('the doorway', () => {
  it('carries the reader into that project when one is offered', async () => {
    const onContinueInProject = vi.fn()
    render(<ProjectAttribution {...props} onContinueInProject={onContinueInProject} />)

    await userEvent.click(screen.getByRole('button', { name: /Continue in the project/ }))

    expect(onContinueInProject).toHaveBeenCalled()
  })

  it('is absent when the caller has no navigation to offer', () => {
    render(<ProjectAttribution {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
