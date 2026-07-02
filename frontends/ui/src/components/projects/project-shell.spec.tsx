import { render, screen } from '@/test-utils'
import { describe, expect, it } from 'vitest'
import { ProjectShell } from './project-shell'

describe('ProjectShell', () => {
  it('renders project OS navigation', () => {
    render(<ProjectShell projectId="project_1" projectName="Hotel Vienna"><div>Content</div></ProjectShell>)

    expect(screen.getByRole('link', { name: /Overview/i })).toHaveAttribute('href', '/projects/project_1')
    expect(screen.getByRole('link', { name: /Files/i })).toHaveAttribute('href', '/projects/project_1/files')
    expect(screen.getByRole('link', { name: /Ask Grid/i })).toHaveAttribute('href', '/projects/project_1/chat')
    expect(screen.getByRole('link', { name: /Members/i })).toHaveAttribute('href', '/projects/project_1/members')
  })
})
