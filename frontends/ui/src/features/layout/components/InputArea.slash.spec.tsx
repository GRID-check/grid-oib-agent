/**
 * `/name` invocation, through the real composer.
 *
 * The pure half is covered directly (`features/skills/lib/slash-command.spec.ts`);
 * what this file covers is the WIRING — that picking a skill puts it on the
 * message envelope, that editing the token away takes it back off, and that a
 * message which merely begins with a slash is still an ordinary message. Those
 * are the seams where the feature would silently do nothing.
 *
 * A separate file from `InputArea.spec.tsx` on purpose: that suite is already
 * the slowest in the project (the repo's own working notes call it out), and it
 * mounts the whole tree per test. Nothing here needs its fixtures.
 */

import { render, screen, waitFor } from '@/test-utils'
import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { InputArea } from './InputArea'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

const mockSendMessage = vi.fn()
vi.mock('@/features/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat')>()
  return {
    ...actual,
    useWebSocketChat: () => ({
      sendMessage: mockSendMessage,
      isLoading: false,
      respondToInteraction: vi.fn(),
      pendingInteraction: null,
      noteSendIntent: vi.fn(),
    }),
  }
})

const listInvocableSkills = vi.fn()
vi.mock('@/adapters/api/skills-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/adapters/api/skills-client')>()),
  listInvocableSkills: (...args: unknown[]) => listInvocableSkills(...args),
}))

const SKILLS = [
  {
    name: 'oib-brandschutz',
    description: 'Prüft Brandschutz nach OIB-RL 2. Bei Anfragen zu Fluchtwegen.',
    origin: 'org' as const,
  },
  {
    name: 'projekt-zusammenfassung',
    description: 'Fasst den Projektstand zusammen.',
    origin: 'org' as const,
  },
]

beforeEach(() => {
  mockSendMessage.mockReset()
  mockSendMessage.mockReturnValue(true)
  listInvocableSkills.mockReset()
  listInvocableSkills.mockResolvedValue(SKILLS)
})

const composer = () => screen.getByRole('textbox')

/**
 * Pick a row by skill name.
 *
 * Not `findByText`: the picker splits the name around a `<mark>` to emphasise
 * the typed fragment, so the name is never one contiguous text node. The row
 * carries its name as a data attribute precisely so a test does not have to
 * care how it is highlighted.
 */
const option = async (name: string): Promise<HTMLElement> => {
  const picker = await screen.findByTestId('slash-command-picker')
  const row = picker.querySelector<HTMLElement>(`[data-skill-name="${name}"]`)
  if (!row) throw new Error(`no picker row for ${name}`)
  return row
}

describe('the composer’s / invocation', () => {
  test('opens the picker on a leading slash and lists name + description', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), '/')

    const picker = await screen.findByTestId('slash-command-picker')
    expect(await option('oib-brandschutz')).toBeInTheDocument()
    // The description is the level-1 metadata the agent also sees; the menu
    // shows exactly that and no body.
    expect(picker).toHaveTextContent('Bei Anfragen zu Fluchtwegen.')
  })

  test('does not open mid-sentence — slashes are ordinary punctuation here', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), 'Gilt OIB-RL 2/3 noch?')

    expect(screen.queryByTestId('slash-command-picker')).not.toBeInTheDocument()
    expect(listInvocableSkills).not.toHaveBeenCalled()
  })

  test('picking a skill inserts the token and puts it on the envelope at send', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), '/oib')
    await screen.findByTestId('slash-command-picker')
    await user.click(await option('oib-brandschutz'))

    await waitFor(() => expect(composer()).toHaveValue('/oib-brandschutz '))
    // The chip states the consequence the bare token cannot.
    expect(await screen.findByTestId('invoked-skill-chip')).toBeInTheDocument()

    await user.type(composer(), 'Stiegenhaus prüfen')
    await user.click(screen.getByRole('button', { name: /send message/i }))

    expect(mockSendMessage).toHaveBeenCalledWith(
      '/oib-brandschutz Stiegenhaus prüfen',
      expect.objectContaining({ skills: ['oib-brandschutz'] }),
    )
  })

  test('deleting the token takes the invocation back off the message', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), '/oib')
    await screen.findByTestId('slash-command-picker')
    await user.click(await option('oib-brandschutz'))
    await screen.findByTestId('invoked-skill-chip')

    await user.clear(composer())
    await user.type(composer(), 'Was gilt für Fluchtwege?')

    await waitFor(() =>
      expect(screen.queryByTestId('invoked-skill-chip')).not.toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /send message/i }))

    // Back to the plain single-argument call the composer has always made.
    expect(mockSendMessage).toHaveBeenCalledWith('Was gilt für Fluchtwege?')
  })

  test('the remove control drops the skill but keeps what was typed', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), '/oib')
    await screen.findByTestId('slash-command-picker')
    await user.click(await option('oib-brandschutz'))
    await user.type(composer(), 'Stiegenhaus prüfen')

    const chip = await screen.findByTestId('invoked-skill-chip')
    await user.click(within(chip).getByRole('button'))

    await waitFor(() => expect(composer()).toHaveValue('Stiegenhaus prüfen'))
  })

  test('a message that merely starts with a slash is sent as written', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), '/etc/hosts ist gemeint')
    await user.click(screen.getByRole('button', { name: /send message/i }))

    expect(mockSendMessage).toHaveBeenCalledWith('/etc/hosts ist gemeint')
  })
})
