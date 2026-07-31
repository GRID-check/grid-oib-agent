/**
 * The typing line: what it says, and when it says nothing.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { TypingPresence } from './TypingPresence'

const person = (userId: string, name: string): DirectoryPerson =>
  ({ userId, name, email: `${userId}@grid.test`, profilePictureUrl: null }) as DirectoryPerson

describe('TypingPresence', () => {
  it('renders nothing when nobody is typing', () => {
    const { container } = render(<TypingPresence typists={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names one colleague', () => {
    render(<TypingPresence typists={[person('u1', 'Anna Berger')]} />)
    expect(screen.getByTestId('typing-presence')).toHaveTextContent('Anna Berger')
  })

  it('names two', () => {
    render(
      <TypingPresence typists={[person('u1', 'Anna Berger'), person('u2', 'Tobias Kern')]} />
    )
    const line = screen.getByTestId('typing-presence')
    expect(line).toHaveTextContent('Anna Berger')
    expect(line).toHaveTextContent('Tobias Kern')
  })

  it('counts the rest instead of listing them', () => {
    // Past two names the line stops being readable and starts being a list.
    render(
      <TypingPresence
        typists={[
          person('u1', 'Anna Berger'),
          person('u2', 'Tobias Kern'),
          person('u3', 'Lena Fuchs'),
          person('u4', 'Marek Novák'),
        ]}
      />
    )
    const line = screen.getByTestId('typing-presence')
    expect(line).toHaveTextContent('2')
    expect(line).not.toHaveTextContent('Lena Fuchs')
  })

  it('announces politely, once', () => {
    render(<TypingPresence typists={[person('u1', 'Anna Berger')]} />)
    const announcement = screen.getByRole('status')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
  })
})
