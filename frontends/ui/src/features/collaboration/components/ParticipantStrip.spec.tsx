import { describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'

import type { ResourceAccessEntry, ResourceRole } from '@/lib/sharing/types'
import { ParticipantStrip, sortByRoleThenName } from './ParticipantStrip'

/** Default locale in an unprovided test tree is `en`. */

const entry = (
  userId: string,
  name: string,
  role: ResourceRole,
  profilePictureUrl: string | null = null,
): ResourceAccessEntry => ({
  person: { userId, name, email: `${userId}@example.com`, profilePictureUrl },
  role,
  reason: 'grant',
  grantedBy: null,
})

const ROSTER = [
  entry('u-zoe', 'Zoe Vogel', 'viewer'),
  entry('u-markus', 'Markus Hofer', 'collaborator'),
  entry('u-matthias', 'Matthias Bigl', 'owner'),
  entry('u-anna', 'Anna Weber', 'collaborator'),
]

describe('ParticipantStrip — solo threads', () => {
  test('renders nothing for a single participant', () => {
    render(<ParticipantStrip entries={[entry('u-me', 'Me', 'owner')]} onOpen={vi.fn()} />)

    // A solo private chat must show no collaboration furniture at all.
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
  })

  test('renders nothing for an empty roster', () => {
    render(<ParticipantStrip entries={[]} onOpen={vi.fn()} />)

    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
  })
})

describe('ParticipantStrip — the stack', () => {
  test('shows initials for people without a photo', () => {
    render(<ParticipantStrip entries={ROSTER} onOpen={vi.fn()} />)

    expect(screen.getByText('MB')).toBeInTheDocument()
    expect(screen.getByText('AW')).toBeInTheDocument()
  })

  test('orders owners first, then the role ladder, then name', () => {
    render(<ParticipantStrip entries={ROSTER} onOpen={vi.fn()} />)

    const initials = screen
      .getAllByTestId('person-avatar')
      .map((avatar) => avatar.textContent?.trim())

    // Matthias (owner) → Anna, Markus (collaborators, alphabetical) → Zoe (viewer).
    expect(initials).toEqual(['MB', 'AW', 'MH', 'ZV'])
  })

  test('collapses the tail into a +N bubble', () => {
    const many = [...ROSTER, entry('u-klaus', 'Klaus Berger', 'viewer'), entry('u-eva', 'Eva Ritter', 'viewer')]
    render(<ParticipantStrip entries={many} onOpen={vi.fn()} />)

    expect(screen.getAllByTestId('person-avatar')).toHaveLength(4)
    expect(screen.getByTestId('avatar-stack-overflow')).toHaveTextContent('+2')
  })

  test('no overflow bubble when everyone fits', () => {
    render(<ParticipantStrip entries={ROSTER} onOpen={vi.fn()} />)

    expect(screen.queryByTestId('avatar-stack-overflow')).not.toBeInTheDocument()
  })

  test('the visible count is configurable', () => {
    render(<ParticipantStrip entries={ROSTER} maxVisible={2} onOpen={vi.fn()} />)

    expect(screen.getAllByTestId('person-avatar')).toHaveLength(2)
    expect(screen.getByTestId('avatar-stack-overflow')).toHaveTextContent('+2')
  })
})

describe('ParticipantStrip — opening the overview', () => {
  test('is ONE button, not one per face, and it opens the overview', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(<ParticipantStrip entries={ROSTER} onOpen={onOpen} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)

    await user.click(buttons[0])
    expect(onOpen).toHaveBeenCalledOnce()
  })

  test('is labelled for screen readers and carries the open hint as its title', () => {
    render(<ParticipantStrip entries={ROSTER} onOpen={vi.fn()} />)

    const strip = screen.getByTestId('participant-strip')
    expect(strip).toHaveAttribute('aria-label', 'People in this conversation')
    expect(strip).toHaveAttribute('title', 'View who has access')
  })

  test('without an onOpen it is a labelled indicator, not a dead button', () => {
    render(<ParticipantStrip entries={ROSTER} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'People in this conversation' })).toBeInTheDocument()
  })

  test('hovering a face reveals the name and what they may do', async () => {
    const user = userEvent.setup()
    render(<ParticipantStrip entries={ROSTER} currentUserId="u-matthias" onOpen={vi.fn()} />)

    await user.hover(screen.getByText('AW'))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Anna Weber')
    expect(tooltip).toHaveTextContent('Can contribute')
  })

  test('the reader’s own face says so', async () => {
    const user = userEvent.setup()
    render(<ParticipantStrip entries={ROSTER} currentUserId="u-matthias" onOpen={vi.fn()} />)

    await user.hover(screen.getByText('MB'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Matthias Bigl (you)')
  })
})

/*
 * The disc itself (identity colour, photo preference, `+N` bubble, overlap
 * geometry) is `@/components/ui/avatar-stack` and is specified there. What stays
 * here is what is genuinely the strip's: the solo rule, the roster ordering, and
 * being one control.
 */

describe('sortByRoleThenName', () => {
  test('does not mutate its input (the roster comes straight from the server state)', () => {
    const input = [...ROSTER]
    sortByRoleThenName(input)
    expect(input.map((item) => item.person.userId)).toEqual(ROSTER.map((item) => item.person.userId))
  })
})
