/**
 * The composer's „Sensible Daten" gate (ADR-0085, "Chat messages are screened
 * too"), through the real composer.
 *
 * A message that matches the office's content terms or detectors is not sent
 * as typed. The composer says what it found and offers exactly two ways on:
 * „Maskiert senden" sends the message with each match replaced by its
 * placeholder, „Bearbeiten" sends nothing and leaves the text in the editor.
 * There is no way to send it unmasked from here. A message with no match, or
 * an office that switched screening off, sends as before.
 *
 * The matcher itself is pinned by `content-screen.spec.ts` against the shared
 * fixture; this file pins the WIRING. Its own file, beside
 * `InputArea.slash.spec.tsx`, because `InputArea.spec.tsx` is already the
 * slowest file in the suite.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import {
  SUGGESTED_SCREENING_POLICY,
  type UploadScreeningPolicy,
} from '@/lib/upload-screening/policy'
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
const mockRespondToInteraction = vi.fn()
const interaction: { pending: unknown } = { pending: null }
vi.mock('@/features/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat')>()
  return {
    ...actual,
    useWebSocketChat: () => ({
      sendMessage: mockSendMessage,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: interaction.pending,
      noteSendIntent: vi.fn(),
    }),
  }
})

const policy: { current: UploadScreeningPolicy } = { current: SUGGESTED_SCREENING_POLICY }
vi.mock('@/adapters/api/upload-screening-policy', () => ({
  loadUploadScreeningPolicy: vi.fn(async () => policy.current),
}))

const IBAN = 'AT61 1904 3002 3457 3201'

beforeEach(() => {
  mockSendMessage.mockReset()
  mockSendMessage.mockReturnValue(true)
  mockRespondToInteraction.mockReset()
  interaction.pending = null
  policy.current = SUGGESTED_SCREENING_POLICY
})

const composer = () => screen.getByRole('textbox')
const send = () => screen.getByRole('button', { name: /send message/i })

/** Type into the composer in one paste: `user.type` would read `[`… as key descriptors. */
async function enter(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(composer())
  await user.paste(text)
}

describe('the composer screens a message against the office’s „Sensible Daten"', () => {
  test('a match is not sent: the composer names it, with a masked sample and never the value', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, `Bitte überweise an ${IBAN}`)
    await user.click(send())

    const notice = await screen.findByTestId('chat-screening-notice')
    expect(notice).toHaveTextContent(
      'Contains an IBAN AT61 •••• •••• •••• 3201 (Sensitive data).'
    )
    expect(notice).toHaveTextContent('The model sees: “Bitte überweise an [IBAN entfernt]”')
    expect(notice).not.toHaveTextContent(IBAN)
    expect(mockSendMessage).not.toHaveBeenCalled()
    // Exactly the two ways on; nothing sends it as typed.
    expect(screen.getByRole('button', { name: 'Send masked' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /unmasked|anyway/i })).not.toBeInTheDocument()
  })

  test('„Maskiert senden" sends the message with each match replaced', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, `Lohnzettel für März, IBAN ${IBAN}`)
    await user.click(send())
    await user.click(await screen.findByRole('button', { name: 'Send masked' }))

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1))
    expect(mockSendMessage).toHaveBeenCalledWith(
      '[Begriff entfernt] für März, IBAN [IBAN entfernt]'
    )
    expect(screen.queryByTestId('chat-screening-notice')).not.toBeInTheDocument()
    await waitFor(() => expect(composer()).toHaveValue(''))
  })

  test('„Bearbeiten" sends nothing and leaves the text as typed', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, `Konto ${IBAN}`)
    await user.click(send())
    await user.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.queryByTestId('chat-screening-notice')).not.toBeInTheDocument()
    expect(composer()).toHaveValue(`Konto ${IBAN}`)
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('editing the text retires the notice, and the edited text is screened afresh', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, `Konto ${IBAN}`)
    await user.click(send())
    await screen.findByTestId('chat-screening-notice')
    await user.clear(composer())
    await enter(user, 'Konto siehe Rechnung')

    expect(screen.queryByTestId('chat-screening-notice')).not.toBeInTheDocument()
    await user.click(send())
    // „Rechnung" is a NAME term, for file and folder names: it does not apply to chat.
    expect(mockSendMessage).toHaveBeenCalledWith('Konto siehe Rechnung')
  })

  test('a message with no match is sent unchanged, with no notice', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, 'Wie breit muss die Stiege sein?')
    await user.click(send())

    expect(mockSendMessage).toHaveBeenCalledWith('Wie breit muss die Stiege sein?')
    expect(screen.queryByTestId('chat-screening-notice')).not.toBeInTheDocument()
  })

  test('an office that switched screening off sends the message unchanged', async () => {
    policy.current = { ...SUGGESTED_SCREENING_POLICY, enabled: false }
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)
    // The policy is read when the composer mounts.
    await waitFor(async () => {
      const { loadUploadScreeningPolicy } = await import('@/adapters/api/upload-screening-policy')
      expect(loadUploadScreeningPolicy).toHaveBeenCalled()
    })

    await enter(user, `IBAN ${IBAN}`)
    await user.click(send())

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith(`IBAN ${IBAN}`))
    expect(screen.queryByTestId('chat-screening-notice')).not.toBeInTheDocument()
  })

  test("an answer to Piloti's question is screened like a question", async () => {
    interaction.pending = { id: 'ask_01', content: { input_type: 'text', text: 'Welches Konto?' } }
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await enter(user, `Das Konto ${IBAN}`)
    await user.click(screen.getByRole('button', { name: /send response/i }))
    expect(mockRespondToInteraction).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Send masked' }))

    await waitFor(() =>
      expect(mockRespondToInteraction).toHaveBeenCalledWith('Das Konto [IBAN entfernt]')
    )
  })
})
