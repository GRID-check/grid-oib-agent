import { describe, expect, test } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'

import { MentionPeopleProvider } from '../context/mention-people'

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
    // The semantic pair the `warning` Chip and Badge already use for "this
    // concerns you" — not `bg-primary`, which made a solid ink block in light and
    // a solid white one in dark, out-shouting the sentence it annotates.
    expect(chip.className).toContain('bg-warning-subtle')
    expect(chip.className).not.toContain('bg-primary')
  })

  test('a mention of someone else stays a quiet reference', () => {
    render(
      <MentionText content="@Anna Weber bitte" mentions={[anna]} currentUserId="u-markus" />,
    )
    const chip = screen.getByTestId('mention-chip')
    expect(chip).toHaveAttribute('data-mention-me', 'false')
    expect(chip.className).not.toContain('bg-warning-subtle')
  })

  /**
   * The property that actually matters, pinned independently of which tokens are
   * in play: a mention of you must not LOOK like a mention of a colleague. Both
   * previous assertions could pass while the two rendered identically.
   */
  test('the two are visually distinguishable', () => {
    const { unmount } = render(
      <MentionText content="@Anna Weber bitte" mentions={[anna]} currentUserId="u-anna" />,
    )
    const mine = screen.getByTestId('mention-chip').className
    unmount()

    render(
      <MentionText content="@Anna Weber bitte" mentions={[anna]} currentUserId="u-markus" />,
    )
    expect(screen.getByTestId('mention-chip').className).not.toBe(mine)
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

/**
 * The pill as a reference you can resolve without leaving the thread.
 *
 * In a project of forty people, "@S. Gruber" is either the fire-safety engineer or
 * somebody in accounts, and a reader who cannot tell either interrupts themselves
 * to go and look or guesses. What these pin is that the peek exists ONLY when
 * there is something true to say — a pill that opens an empty panel is worse than
 * plain text.
 */
describe('MentionText — the peek behind a pill', () => {
  const roster = [
    { userId: 'u-anna', name: 'Anna Weber', email: 'anna@example.com', profilePictureUrl: null },
  ]

  const withPeople = (ui: JSX.Element, currentUserId?: string | null) =>
    render(
      <MentionPeopleProvider participants={roster} currentUserId={currentUserId} agentName="Piloti">
        {ui}
      </MentionPeopleProvider>,
    )

  test('stays a plain span with no provider — a private thread grows no furniture (NF-8)', () => {
    render(<MentionText content="@Anna Weber bitte" mentions={[anna]} />)
    const chip = screen.getByTestId('mention-chip')
    expect(chip.tagName).toBe('SPAN')
    expect(chip).not.toHaveAttribute('data-mention-interactive')
  })

  test('stays a plain span when the provider is disabled', () => {
    render(
      <MentionPeopleProvider participants={roster} agentName="Piloti" enabled={false}>
        <MentionText content="@Anna Weber bitte" mentions={[anna]} />
      </MentionPeopleProvider>,
    )
    expect(screen.getByTestId('mention-chip').tagName).toBe('SPAN')
  })

  test('becomes a button once the person resolves, and opens their card', async () => {
    const user = userEvent.setup()
    withPeople(<MentionText content="@Anna Weber bitte" mentions={[anna]} />)

    const chip = screen.getByTestId('mention-chip')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')

    await user.click(chip)

    const peek = await screen.findByTestId('person-peek')
    expect(peek).toHaveTextContent('Anna Weber')
    expect(peek).toHaveTextContent('anna@example.com')
    expect(screen.getByTestId('person-peek-access')).toHaveTextContent('Can read this conversation')
  })

  test('the assistant gets its own card rather than an email address', async () => {
    const user = userEvent.setup()
    withPeople(<MentionText content="@Piloti bitte weiter" mentions={[agent]} />)

    await user.click(screen.getByTestId('mention-chip'))

    const peek = await screen.findByTestId('person-peek')
    expect(peek).toHaveTextContent('Piloti')
    expect(peek).toHaveTextContent('Assistant in this project')
    // "Can read this conversation" is a category error about the assistant.
    expect(screen.queryByTestId('person-peek-access')).not.toBeInTheDocument()
  })

  test('a mention of someone no longer in the roster stays plain — no guessing about access', () => {
    withPeople(
      <MentionText
        content="@Tobias Kern hatte das geprüft"
        mentions={[{ targetId: 'u-tobias', display: 'Tobias Kern' }]}
      />,
    )
    const chip = screen.getByTestId('mention-chip')
    expect(chip.tagName).toBe('SPAN')
    // The name still reads — it travels with the message, not with the roster.
    expect(chip).toHaveTextContent('@Tobias Kern')
  })

  test('a mention of the reader says so on the card too', async () => {
    const user = userEvent.setup()
    withPeople(<MentionText content="@Anna Weber bitte" mentions={[anna]} />, 'u-anna')

    await user.click(screen.getByTestId('mention-chip'))

    expect(await screen.findByTestId('person-peek')).toHaveTextContent('Anna Weber (you)')
  })
})
