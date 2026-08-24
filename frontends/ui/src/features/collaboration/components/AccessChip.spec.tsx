import { describe, expect, test } from 'vitest'
import { render, screen } from '@/test-utils'

import type { ResourceAccessEntry } from '@/lib/sharing/types'
import { AccessChip, namedAudienceCount } from './AccessChip'

/** Default locale in an unprovided test tree is `en`. */

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${userId}@example.com`,
  profilePictureUrl: null,
})

const entry = (
  userId: string,
  role: ResourceAccessEntry['role'],
  reason: ResourceAccessEntry['reason'],
): ResourceAccessEntry => ({
  person: person(userId, userId),
  role,
  reason,
  grantedBy: null,
})

describe('AccessChip', () => {
  test('a private resource with nobody else reads as private, with a lock', () => {
    render(<AccessChip visibility="private" />)

    const chip = screen.getByTestId('access-chip')
    expect(chip).toHaveTextContent('Private')
    expect(chip).toHaveAttribute('data-state', 'private')
    expect(chip.querySelector('svg.lucide-lock')).not.toBeNull()
  })

  test('a private-but-shared resource says who it is shared with — and is NOT a lock', () => {
    render(<AccessChip visibility="private" sharedWith={3} />)

    const chip = screen.getByTestId('access-chip')
    expect(chip).toHaveTextContent('Shared with 3')
    expect(chip).toHaveAttribute('data-state', 'shared')
    // A shared thread wearing a padlock would be a lie the reader has to click
    // to discover.
    expect(chip.querySelector('svg.lucide-lock')).toBeNull()
  })

  test('one person uses the singular key (this i18n layer has no plural rules)', () => {
    render(<AccessChip visibility="private" sharedWith={1} />)

    expect(screen.getByTestId('access-chip')).toHaveTextContent('Shared with 1')
  })

  test('project and organization state the blanket rule, ignoring any count', () => {
    const { rerender } = render(<AccessChip visibility="project" sharedWith={7} />)
    expect(screen.getByTestId('access-chip')).toHaveTextContent('Project')

    rerender(<AccessChip visibility="organization" sharedWith={7} />)
    expect(screen.getByTestId('access-chip')).toHaveTextContent('Organization')
  })

  test('every state has its own glyph, so the chip is readable without colour', () => {
    const glyphs = (['private', 'project', 'organization'] as const).map((visibility) => {
      const { unmount } = render(<AccessChip visibility={visibility} />)
      const icon = screen.getByTestId('access-chip').querySelector('svg')?.getAttribute('class')
      unmount()
      return icon
    })
    expect(new Set(glyphs).size).toBe(3)
  })

  test('announces itself as a labelled indicator', () => {
    render(<AccessChip visibility="project" />)

    expect(screen.getByRole('img', { name: 'Access: Project' })).toBeInTheDocument()
  })

  test('a nonsense count degrades to the plain private state rather than rendering NaN', () => {
    render(<AccessChip visibility="private" sharedWith={Number.NaN} />)

    expect(screen.getByTestId('access-chip')).toHaveTextContent('Private')
  })

  test('carries the raw visibility as data, so lists can style/test on it', () => {
    render(<AccessChip visibility="private" sharedWith={2} />)

    expect(screen.getByTestId('access-chip')).toHaveAttribute('data-visibility', 'private')
  })
})

describe('namedAudienceCount', () => {
  test('counts explicit grants and the creator, excluding the reader', () => {
    const entries = [
      entry('me', 'owner', 'creator'),
      entry('anna', 'collaborator', 'grant'),
      entry('markus', 'viewer', 'grant'),
    ]

    expect(namedAudienceCount(entries, 'me')).toBe(2)
  })

  test('ignores visibility-derived rows — those are the blanket rule, not an audience', () => {
    const entries = [
      entry('me', 'owner', 'creator'),
      entry('anna', 'collaborator', 'visibility-project'),
      entry('klaus', 'collaborator', 'visibility-organization'),
    ]

    expect(namedAudienceCount(entries, 'me')).toBe(0)
  })

  test('without a known reader, nobody is excluded', () => {
    expect(namedAudienceCount([entry('me', 'owner', 'creator')])).toBe(1)
  })
})
