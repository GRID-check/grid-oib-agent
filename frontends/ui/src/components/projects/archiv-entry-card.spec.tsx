import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { ArchivEntryCard } from './archiv-entry-card'

describe('ArchivEntryCard', () => {
  test('links to the org-wide Archiv with title and explainer', () => {
    render(<ArchivEntryCard />)

    const link = screen.getByRole('link', { name: /archiv/i })
    expect(link).toHaveAttribute('href', '/app/archiv')
    expect(screen.getByText('Archiv')).toBeInTheDocument()
    expect(screen.getByText(/organization-wide knowledge/i)).toBeInTheDocument()
  })
})
