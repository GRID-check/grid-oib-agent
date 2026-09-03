/**
 * The last hop of the `grid-hidden` chain: the answer hands the disclosure its data.
 *
 * `grid-hidden` metadata → `SkillRuntime.hidden_activated` → `skills_hidden` on
 * the terminal frame → `skillsHidden` on the message → `AgentResponse` →
 * `SkillsUsedDisclosure`, where the reader's `showReasoningSkills` preference
 * decides whether a hidden row reads muted or at full weight.
 *
 * Both ENDS were pinned and the hop between them was not.
 * `skills-transparency.spec.tsx` renders the disclosure with `hiddenSkills` and
 * `showReasoning` handed to it directly; nothing asserted that the answer is
 * what hands them over, so replacing `hiddenSkills={skillsHidden}` with
 * `hiddenSkills={undefined}` in BOTH of `AgentResponse`'s variants left the
 * whole suite green — and the house voice then reads at full weight under every
 * answer, which is the noise the flag exists to remove.
 *
 * Rendered for both variants, because the prop is passed twice: the default
 * "Ergebnis" card the thread uses, and the box-less inline rendering used
 * inside another container. One of the two was always going to be the one a
 * refactor forgot.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      openRightPanel: vi.fn(),
      setResearchPanelTab: vi.fn(),
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      reportContent: '',
      deepResearchJobId: null,
      isDeepResearchStreaming: false,
      deepResearchStreamLoaded: false,
      currentConversation: null,
      patchConversationMessage: vi.fn(),
      reconnectToActiveJob: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('../hooks', () => ({
  useLoadJobData: () => ({
    loadReport: vi.fn(),
    importJobStream: vi.fn(),
    loadResearchPanelTab: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }),
}))

// The disclosure fetches descriptions on expand; a standard skill has none,
// which is the shape this test wants anyway.
const listInvocableSkills = vi.fn()
vi.mock('@/adapters/api/skills-client', () => ({
  listInvocableSkills: (...args: unknown[]) => listInvocableSkills(...args),
}))

vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

beforeEach(() => {
  listInvocableSkills.mockReset()
  listInvocableSkills.mockResolvedValue([
    { name: 'oib-brandschutz', description: 'Prüft Brandschutz nach OIB-RL 2.', origin: 'org' },
  ])
})

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('names both skills and mutes the hidden one', async () => {
    const user = userEvent.setup()
    render(
      <AgentResponse
        content="Die Antwort."
        variant={variant}
        skillsActivated={['oib-brandschutz', 'piloti-voice']}
        skillsHidden={['piloti-voice']}
      />
    )

    // The skills record lives inside the answer-details disclosure now.
    await user.click(screen.getByTestId('answer-details-trigger'))
    await user.click(screen.getByTestId('skills-used-trigger'))
    const panel = await screen.findByTestId('skills-used-panel')
    // The record names everything that ran — hidden is never concealed.
    expect(panel).toHaveTextContent('oib-brandschutz')
    expect(panel).toHaveTextContent('piloti-voice')
    // …and the answer is what told the disclosure which row is the hidden one.
    const hiddenRow = screen.getByTestId('skills-used-hidden-row')
    expect(hiddenRow).toHaveTextContent('piloti-voice')
    expect(hiddenRow.className).toContain('opacity-60')
  })

  test("the reader's reasoning preference reaches the row", async () => {
    const user = userEvent.setup()
    render(
      <AgentResponse
        content="Die Antwort."
        variant={variant}
        skillsActivated={['piloti-voice']}
        skillsHidden={['piloti-voice']}
        showReasoning
      />
    )

    await user.click(screen.getByTestId('answer-details-trigger'))
    await user.click(screen.getByTestId('skills-used-trigger'))
    const hiddenRow = await screen.findByTestId('skills-used-hidden-row')
    // Presence never changes; emphasis does. A `showReasoning` that stops being
    // threaded leaves the reader's own setting with no effect on the answer.
    expect(hiddenRow).toHaveTextContent('piloti-voice')
    expect(hiddenRow.className).not.toContain('opacity-60')
  })
})
