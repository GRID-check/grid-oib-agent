import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { UserMessage } from './UserMessage'

describe('UserMessage', () => {
  test('renders message content', () => {
    render(<UserMessage content="Hello, how can you help me?" />)

    expect(screen.getByText('Hello, how can you help me?')).toBeInTheDocument()
  })

  test('preserves whitespace in content', () => {
    const multilineContent = `Line 1
Line 2
Line 3`

    const { container } = render(<UserMessage content={multilineContent} />)

    // Single newlines within a markdown paragraph are preserved as soft breaks
    const markdown = container.querySelector('.markdown-content')
    expect(markdown?.textContent).toBe(multilineContent)
  })

  test('renders empty content', () => {
    const { container } = render(<UserMessage content="" />)

    // Component should still render, just with empty text
    expect(container.querySelector('[class*="rounded"]')).toBeInTheDocument()
  })

  test('renders long content', () => {
    const longContent = 'A'.repeat(1000)

    render(<UserMessage content={longContent} />)

    expect(screen.getByText(longContent)).toBeInTheDocument()
  })

  test('renders special characters', () => {
    const { container } = render(<UserMessage content="Code: `const x = 1` and <html> tags" />)

    // Since MarkdownRenderer renders markdown, check for the presence of content parts
    expect(container.textContent).toContain('Code:')
    expect(container.textContent).toContain('const x = 1')
  })

  test('displays timestamp when provided', () => {
    const timestamp = new Date('2024-01-15T14:30:00')

    render(<UserMessage content="Hello" timestamp={timestamp} />)

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('handles ISO string timestamp', () => {
    render(<UserMessage content="Hello" timestamp="2024-01-15T14:30:00Z" />)

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('does not display timestamp when not provided', () => {
    const { container } = render(<UserMessage content="Hello" />)

    // No timestamp text should be present
    expect(container.querySelectorAll('[class*="text-subtle"]')).toHaveLength(0)
  })

  // ── Solo threads must not change at all (spec CC-4, NF-8) ────────────────────
  describe('without an author (solo thread)', () => {
    test('renders the unattributed "Eingabe" bubble, with no authorship anywhere', () => {
      render(<UserMessage content="Hello" timestamp={new Date('2026-07-29T09:05:00Z')} />)

      expect(screen.getByText(/input/i)).toBeInTheDocument()
      expect(screen.queryByTestId('message-author')).not.toBeInTheDocument()
      expect(screen.queryByTestId('message-author-initials')).not.toBeInTheDocument()
    })
  })

  // ── Shared threads: who said this, at a glance (spec CC-4, CC-5) ─────────────
  describe('with an author (shared thread)', () => {
    test("renders a colleague's name and avatar, without the role tab", () => {
      render(
        <UserMessage
          content="Der Innenhof ist verschlossen."
          author={{ userId: 'user_anna', name: 'Anna Berger' }}
        />
      )

      expect(screen.getByText('Anna Berger')).toBeInTheDocument()
      expect(screen.getByTestId('message-author-initials')).toHaveTextContent('AB')
      // The author header replaces the generic role tab — showing both is noise.
      expect(screen.queryByText(/^input$/i)).not.toBeInTheDocument()
    })

    test("names the reader's own message 'You'", () => {
      render(
        <UserMessage
          content="Meine Frage"
          author={{ userId: 'user_me', name: 'Max Mustermann', isYou: true }}
        />
      )

      expect(screen.getByText('You')).toBeInTheDocument()
    })

    test('every human message stays on the same side, whoever wrote it', () => {
      // Left/right is the grammar of a group chat between people. Piloti is the
      // thing being talked to, so humans keep ONE column — a colleague's bubble
      // is never mirrored across it.
      const colleague = render(
        <UserMessage content="x" author={{ userId: 'user_anna', name: 'Anna Berger' }} />
      )
      const mine = render(
        <UserMessage content="x" author={{ userId: 'user_me', name: 'Me', isYou: true }} />
      )

      for (const { container } of [colleague, mine]) {
        expect(container.querySelector('.items-end')).toBeInTheDocument()
        expect(container.querySelector('.items-start')).toBeNull()
      }
    })

    test("a colleague's bubble is the same bubble as the reader's own", () => {
      // Differentiation is the avatar + name header, NOT a second bubble
      // treatment: no muted surface, no mirrored corner, no per-person colour.
      const colleague = render(
        <UserMessage content="x" author={{ userId: 'user_anna', name: 'Anna Berger' }} />
      )
      const mine = render(
        <UserMessage content="x" author={{ userId: 'user_me', name: 'Me', isYou: true }} />
      )

      for (const { container } of [colleague, mine]) {
        expect(container.querySelector('.bg-card')).toBeInTheDocument()
        expect(container.querySelector('.bg-muted\\/45')).toBeNull()
      }
      // Same asymmetric corner on both, so neither reads as "the other side".
      expect(colleague.container.querySelector('.rounded-\\[12px_4px_12px_12px\\]')).toBeInTheDocument()
      expect(mine.container.querySelector('.rounded-\\[12px_4px_12px_12px\\]')).toBeInTheDocument()
    })

    test('a grouped message repeats no header and stays attributable to a screen reader', () => {
      render(
        <UserMessage
          content="Nachtrag"
          author={{ userId: 'user_anna', name: 'Anna Berger' }}
          grouped
          timestamp={new Date('2026-07-29T09:06:00Z')}
        />
      )

      expect(screen.queryByTestId('message-author')).not.toBeInTheDocument()
      expect(screen.getByText('Continued from Anna Berger')).toHaveClass('sr-only')
      // The header carried the time; a grouped follow-up keeps its own under the bubble.
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('renders a structured mention as a chip in the text', () => {
      render(
        <UserMessage
          content="@Anna Berger kannst du den Plan prüfen?"
          author={{ userId: 'user_me', name: 'Me', isYou: true }}
          mentions={[{ targetId: 'user_anna', display: 'Anna Berger' }]}
          currentUserId="user_anna"
        />
      )

      const chip = screen.getByTestId('mention-chip')
      expect(chip).toHaveAttribute('data-mention-target', 'user_anna')
      expect(chip).toHaveTextContent('Anna Berger')
    })

    test('text that merely looks like a mention stays plain text (spec MN-3)', () => {
      render(
        <UserMessage
          content="@Anna Berger kannst du den Plan prüfen?"
          author={{ userId: 'user_me', name: 'Me', isYou: true }}
        />
      )

      expect(screen.queryByTestId('mention-chip')).not.toBeInTheDocument()
    })

    test('renders the message text itself either way', () => {
      render(
        <UserMessage content="Gilt die 40-m-Grenze?" author={{ userId: 'user_anna', name: 'Anna' }} />
      )

      expect(screen.getByText('Gilt die 40-m-Grenze?')).toBeInTheDocument()
    })
  })
})
