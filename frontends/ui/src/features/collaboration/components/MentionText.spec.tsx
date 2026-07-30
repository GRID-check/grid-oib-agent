import { describe, expect, test } from 'vitest'
import { render, screen } from '@/test-utils'

import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { MentionText } from './MentionText'

const anna = { targetId: 'u-anna', display: 'Anna Weber' }
const agent = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

describe('MentionText', () => {
  test('renders the text with the mention as a chip and keeps the prose intact', () => {
    render(<MentionText content="Hallo @Anna Weber, passt das?" mentions={[anna]} />)
    expect(screen.getByTestId('mention-text')).toHaveTextContent(
      'Hallo @Anna Weber, passt das?',
    )
    const chips = screen.getAllByTestId('mention-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('@Anna Weber')
    expect(chips[0]).toHaveAttribute('aria-label', 'Mention of Anna Weber')
  })

  test('a mention of YOU is louder and says so to a screen reader', () => {
    render(
      <MentionText content="@Anna Weber bitte" mentions={[anna]} currentUserId="u-anna" />,
    )
    const chip = screen.getByTestId('mention-chip')
    expect(chip).toHaveAttribute('aria-label', 'You were mentioned')
    expect(chip).toHaveAttribute('data-mention-me', 'true')
    expect(chip.className).toContain('bg-primary')
  })

  test('a mention of someone else stays a quiet reference', () => {
    render(
      <MentionText content="@Anna Weber bitte" mentions={[anna]} currentUserId="u-markus" />,
    )
    const chip = screen.getByTestId('mention-chip')
    expect(chip).toHaveAttribute('data-mention-me', 'false')
    expect(chip.className).not.toContain('bg-primary ')
  })

  test('the assistant is chipped distinctly from a person', () => {
    render(<MentionText content="@Piloti prüfe das" mentions={[agent]} />)
    const chip = screen.getByTestId('mention-chip')
    expect(chip).toHaveAttribute('data-mention-target', AGENT_MENTION_ID)
    expect(chip).toHaveTextContent('@Piloti')
  })

  test('text that only LOOKS like a mention is plain text (MN-3)', () => {
    render(<MentionText content="@Anna Weber und @Fremde Person" mentions={[anna]} />)
    expect(screen.getAllByTestId('mention-chip')).toHaveLength(1)
    expect(screen.getByTestId('mention-text')).toHaveTextContent(
      '@Anna Weber und @Fremde Person',
    )
  })

  test('a message with no mentions renders as plain text', () => {
    render(<MentionText content="Nur Text" />)
    expect(screen.queryByTestId('mention-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('mention-text')).toHaveTextContent('Nur Text')
  })

  test('is XSS-safe: markup in the content is never interpreted', () => {
    render(
      <MentionText
        content='@Anna Weber <img src=x onerror="alert(1)"> <script>alert(2)</script>'
        mentions={[anna]}
      />,
    )
    const host = screen.getByTestId('mention-text')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('script')).toBeNull()
    expect(host).toHaveTextContent('<img src=x onerror="alert(1)">')
  })

  test('renders both chips when one display is a prefix of the other', () => {
    render(
      <MentionText
        content="@Anna Weber und @Anna"
        mentions={[anna, { targetId: 'u-anna-2', display: 'Anna' }]}
      />,
    )
    const chips = screen.getAllByTestId('mention-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['@Anna Weber', '@Anna'])
    expect(chips[0]).toHaveAttribute('data-mention-target', 'u-anna')
    expect(chips[1]).toHaveAttribute('data-mention-target', 'u-anna-2')
  })
})
