import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'

import { AvatarStack, PersonAvatar, type AvatarStackPerson } from './avatar-stack'
import { avatarHue } from './avatar-identity'

const person = (
  userId: string,
  name: string,
  profilePictureUrl: string | null = null,
): AvatarStackPerson => ({ userId, name, profilePictureUrl })

const PEOPLE = [
  person('u-matthias', 'Matthias Bigl'),
  person('u-anna', 'Anna Weber'),
  person('u-markus', 'Markus Hofer'),
  person('u-zoe', 'Zoe Vogel'),
]

describe('AvatarStack', () => {
  test('renders nothing for an empty group', () => {
    const { container } = render(<AvatarStack people={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('draws a disc per person, with their initials', () => {
    render(<AvatarStack people={PEOPLE} />)

    expect(screen.getAllByTestId('person-avatar')).toHaveLength(4)
    expect(screen.getByText('MB')).toBeInTheDocument()
    expect(screen.getByText('ZV')).toBeInTheDocument()
  })

  test('renders people in the order given — ordering is the caller’s information', () => {
    // "Owners first" / "oldest request first" is a decision the caller has already
    // made; a primitive that re-sorted would silently overrule it.
    const reversed = [...PEOPLE].reverse()
    render(<AvatarStack people={reversed} />)

    const initials = screen
      .getAllByTestId('person-avatar')
      .map((disc) => disc.textContent?.trim())
    expect(initials).toEqual(['ZV', 'MH', 'AW', 'MB'])
  })

  test('collapses the tail into a +N bubble', () => {
    render(<AvatarStack people={[...PEOPLE, person('u-eva', 'Eva Ritter')]} max={3} />)

    expect(screen.getAllByTestId('person-avatar')).toHaveLength(3)
    expect(screen.getByTestId('avatar-stack-overflow')).toHaveTextContent('+2')
  })

  test('no bubble when everybody fits', () => {
    render(<AvatarStack people={PEOPLE} max={4} />)
    expect(screen.queryByTestId('avatar-stack-overflow')).not.toBeInTheDocument()
  })

  test('shows at least one face even when asked for none', () => {
    render(<AvatarStack people={PEOPLE} max={0} />)
    expect(screen.getAllByTestId('person-avatar')).toHaveLength(1)
    expect(screen.getByTestId('avatar-stack-overflow')).toHaveTextContent('+3')
  })

  test('is not interactive on its own — a caller supplies the control', () => {
    render(<AvatarStack people={PEOPLE} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  test('lets a caller wrap each face, e.g. in a tooltip trigger', () => {
    render(
      <AvatarStack
        people={PEOPLE.slice(0, 2)}
        renderPerson={(subject, face) => <span title={subject.name}>{face}</span>}
      />,
    )

    expect(screen.getByTitle('Matthias Bigl')).toBeInTheDocument()
    expect(screen.getByTitle('Anna Weber')).toBeInTheDocument()
  })

  test('the same person twice keeps both faces (two outstanding requests)', () => {
    render(<AvatarStack people={[PEOPLE[1], PEOPLE[1]]} />)
    expect(screen.getAllByTestId('person-avatar')).toHaveLength(2)
  })

  test('the discs are large enough that two initials are not clipped by the overlap', () => {
    // 24px discs lost their trailing edge to the negative margin plus the next
    // disc's ring, which cut the second initial off; 28px was the measured fix.
    render(<AvatarStack people={PEOPLE} size="sm" />)
    for (const disc of screen.getAllByTestId('person-avatar')) {
      expect(disc).toHaveClass('size-7')
    }
  })
})

describe('PersonAvatar', () => {
  test('uses the same colour for the same person, at every size and surface', () => {
    render(
      <>
        <PersonAvatar person={PEOPLE[3]} />
        <PersonAvatar person={PEOPLE[3]} size="sm" />
      </>,
    )

    const [first, second] = screen.getAllByTestId('person-avatar')
    expect(first.getAttribute('data-avatar-hue')).toBe(second.getAttribute('data-avatar-hue'))
    expect(first).toHaveAttribute('data-avatar-hue', String(avatarHue('u-zoe')))
  })

  test('different people are drawn in different colours', () => {
    render(
      <>
        <PersonAvatar person={PEOPLE[3]} />
        <PersonAvatar person={PEOPLE[2]} />
      </>,
    )

    const [first, second] = screen.getAllByTestId('person-avatar')
    expect(first.getAttribute('data-avatar-hue')).not.toBe(second.getAttribute('data-avatar-hue'))
  })

  test('prefers a real profile picture when there is one', () => {
    render(<PersonAvatar person={person('u-x', 'Xaver Huber', 'https://cdn/x.png')} />)

    // Radix only swaps the image in once it loads, so the initials must be the
    // fallback that is always present.
    expect(screen.getByTestId('person-avatar')).toHaveTextContent('XH')
  })

  test('a standalone disc carries no stack ring — the ring is the overlap’s job', () => {
    render(<PersonAvatar person={PEOPLE[0]} />)
    expect(screen.getByTestId('person-avatar')).not.toHaveClass('ring-2')
  })
})
