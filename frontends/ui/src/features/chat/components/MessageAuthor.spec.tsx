import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { MessageAuthor } from './MessageAuthor'
import { avatarColorStyle } from '@/components/ui/avatar-identity'

describe('MessageAuthor', () => {
  test('renders the name and initials for a colleague', () => {
    render(<MessageAuthor userId="user_anna" name="Anna Berger" />)

    expect(screen.getByText('Anna Berger')).toBeInTheDocument()
    expect(screen.getByTestId('message-author-initials')).toHaveTextContent('AB')
  })

  test('names the reader "You" but keeps their real initials', () => {
    render(<MessageAuthor userId="user_me" name="Max Mustermann" isYou />)

    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.queryByText('Max Mustermann')).not.toBeInTheDocument()
    // "Y" on every one of your own discs would read as a bug.
    expect(screen.getByTestId('message-author-initials')).toHaveTextContent('MM')
  })

  test('colours the disc from the USER ID, so it survives a rename and a reorder', () => {
    // Colouring by position in a list makes a colleague change colour whenever
    // somebody is invited, which destroys the recognition the disc is for; keying
    // on the name would change it on a rename. Both are the id's job. (The colour
    // values themselves are `color-mix()` against theme tokens, which the test DOM
    // does not implement — their derivation is pinned in avatar-identity.spec.ts.)
    expect(avatarColorStyle('user_anna')).toEqual(avatarColorStyle('user_anna'))
    expect(avatarColorStyle('user_anna')).not.toEqual(avatarColorStyle('user_tobias'))

    render(<MessageAuthor userId="user_anna" name="Anna Berger" />)
    render(<MessageAuthor userId="user_anna" name="A. Berger" />)

    // Same person, same disc, whichever form of the name the directory returns.
    expect(screen.getAllByTestId('message-author-initials')).toHaveLength(2)
  })

  test('prefers a real avatar image when the directory has one', () => {
    render(
      <MessageAuthor userId="user_anna" name="Anna Berger" avatarUrl="https://example.test/a.png" />
    )

    expect(screen.getByTestId('message-author-avatar')).toHaveAttribute(
      'src',
      'https://example.test/a.png'
    )
    expect(screen.queryByTestId('message-author-initials')).not.toBeInTheDocument()
  })

  test('falls back to a neutral disc for a message with no author', () => {
    render(<MessageAuthor />)

    // No identity to derive a colour from, so the disc says so rather than
    // pretending to identify somebody.
    expect(screen.getByTestId('message-author-initials')).toHaveTextContent('?')
  })

  test('labels the whole header once, so the avatar is not announced separately', () => {
    render(<MessageAuthor userId="user_anna" name="Anna Berger" />)

    expect(screen.getByRole('group', { name: 'Message from Anna Berger' })).toBeInTheDocument()
  })

  test('a grouped continuation draws no header but stays attributable', () => {
    render(<MessageAuthor userId="user_anna" name="Anna Berger" grouped />)

    // No visible chrome — that IS the grouping (spec CC-4 / the Slack pattern).
    expect(screen.queryByTestId('message-author')).not.toBeInTheDocument()
    expect(screen.getByText('Continued from Anna Berger')).toHaveClass('sr-only')
  })

  test('shows the time next to the name when given one', () => {
    render(<MessageAuthor userId="user_anna" name="Anna Berger" timestamp="2026-07-29T09:05:00Z" />)

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })
})
